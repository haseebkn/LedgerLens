{{
  config(
    materialized='incremental',
    unique_key='row_id',
    incremental_strategy='delete+insert',
    pre_hook="{{ prune_deleted_context_rows() }}"
  )
}}

WITH calendar_events AS (
    SELECT
        'calendar_' || event_id AS row_id,
        'calendar' AS source,
        start_time AS event_timestamp,
        extracted_at,
        -- Generate narrative text summary for context
        'Calendar Event: ' || COALESCE(summary, '(No Title)') ||
        ' at ' || COALESCE(location, 'No Location') ||
        CASE WHEN all_day THEN
            ' (all-day) from ' || source_start || ' to ' || source_end || ' (end date exclusive)'
        WHEN time_zone_known THEN
            ' from ' || strftime(start_time, '%Y-%m-%dT%H:%M:%SZ') ||
            ' to ' || strftime(end_time, '%Y-%m-%dT%H:%M:%SZ') || ' (UTC)'
        ELSE ' from ' || COALESCE(source_start, 'N/A') ||
             ' to ' || COALESCE(source_end, 'N/A') || ' (timezone unspecified)' END ||
        '. Description: ' || COALESCE(description, '(None)') AS summary_text,
        -- Construct JSON string for structured fallback
        to_json({
            'event_id': event_id,
            'summary': summary,
            'description': description,
            'start_time': start_time,
            'end_time': end_time,
            'source_start': source_start,
            'source_end': source_end,
            'source_start_zone': source_start_zone,
            'source_end_zone': source_end_zone,
            'all_day': all_day,
            'start_time_utc': CASE WHEN NOT all_day AND time_zone_known THEN strftime(start_time, '%Y-%m-%dT%H:%M:%SZ') END,
            'end_time_utc': CASE WHEN NOT all_day AND time_zone_known THEN strftime(end_time, '%Y-%m-%dT%H:%M:%SZ') END,
            'location': location,
            'organizer_email': organizer_email
        }) AS raw_payload
    FROM {{ ref('int_calendar_events') }}
),

plaid_transactions AS (
    SELECT
        'plaid_' || transaction_id AS row_id,
        'plaid' AS source,
        CAST(transaction_date AS TIMESTAMP) AS event_timestamp,
        extracted_at,
        -- Generate narrative text summary depending on transaction type
        CASE
            WHEN amount > 0 THEN 'Financial Transaction: Spent $' || CAST(amount AS VARCHAR) || ' at ' || COALESCE(name, 'unknown vendor')
            ELSE 'Financial Transaction: Received $' || CAST(ABS(amount) AS VARCHAR) || ' at ' || COALESCE(name, 'unknown vendor')
        END || ' under category ' || COALESCE(primary_category, 'General') ||
        ' on ' || strftime(transaction_date, '%Y-%m-%d') || '.' AS summary_text,
        to_json({
            'transaction_id': transaction_id,
            'account_id': account_id,
            'amount': amount,
            'name': name,
            'category': primary_category,
            'date': transaction_date,
            'pending': is_pending
        }) AS raw_payload
    FROM {{ ref('int_plaid_transactions') }}
),

deduplicated_alpaca_orders AS (
    SELECT *
    FROM {{ ref('stg_alpaca_orders') }}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY extracted_at DESC) = 1
),

alpaca_orders AS (
    SELECT
        'alpaca_' || order_id AS row_id,
        'alpaca' AS source,
        created_at AS event_timestamp,
        extracted_at,
        -- Generate narrative text summary for Alpaca transactions
        'Financial Trade: ' || COALESCE(UPPER(side), 'UNKNOWN SIDE') ||
        ' order of ' || CAST(quantity AS VARCHAR) || ' shares of ' || symbol ||
        ' (' || order_type || ') was ' || status ||
        ' at average price $' || COALESCE(CAST(filled_avg_price AS VARCHAR), 'N/A') ||
        ' on ' || strftime(created_at, '%Y-%m-%d %H:%M') || '.' AS summary_text,
        to_json({
            'order_id': order_id,
            'client_order_id': client_order_id,
            'symbol': symbol,
            'quantity': quantity,
            'side': side,
            'status': status,
            'filled_price': filled_avg_price,
            'created_at': created_at,
            'filled_at': filled_at
        }) AS raw_payload
    FROM deduplicated_alpaca_orders
),

unioned AS (
    SELECT * FROM calendar_events
    UNION ALL
    SELECT * FROM plaid_transactions
    UNION ALL
    SELECT * FROM alpaca_orders
)

SELECT
    row_id,
    source,
    event_timestamp,
    extracted_at,
    summary_text,
    raw_payload
FROM unioned

-- Merge the complete deduplicated state on every build. A global extraction
-- watermark drops late-arriving files from a slower source (and rows arriving
-- at exactly the watermark). The landing zone is already scanned in full by
-- the upstream views, so filtering here cannot avoid that work. The pre-hook
-- propagates deletions, which delete+insert alone cannot see in its input.
