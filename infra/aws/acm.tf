# Optional TLS certificate for a custom domain on CloudFront. When domain_name
# is empty (the default), none of these resources are created and the app is
# served over HTTPS on CloudFront's built-in https://<id>.cloudfront.net URL.

locals {
  has_custom_domain = var.domain_name != ""
  manage_dns        = local.has_custom_domain && var.route53_zone_id != ""
}

resource "aws_acm_certificate" "app" {
  count             = local.has_custom_domain ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = local.manage_dns ? {
    for option in aws_acm_certificate.app[0].domain_validation_options : option.domain_name => option
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  count                   = local.has_custom_domain ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = local.manage_dns ? [for record in aws_route53_record.certificate_validation : record.fqdn] : null
}

resource "aws_route53_record" "app" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
