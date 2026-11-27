# TLS for the public ALB. The certificate is validated by DNS: with
# route53_zone_id set, Terraform writes the validation record and waits;
# without it, `terraform apply` prints the record to add at your DNS
# provider (output certificate_validation_records) and waits until the
# certificate is issued.

locals {
  manage_dns = var.route53_zone_id != ""
}

resource "aws_acm_certificate" "app" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = local.manage_dns ? {
    for option in aws_acm_certificate.app.domain_validation_options : option.domain_name => option
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = local.manage_dns ? [for record in aws_route53_record.certificate_validation : record.fqdn] : null
}

resource "aws_route53_record" "app" {
  count = local.manage_dns ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
