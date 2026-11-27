{% macro prune_deleted_context_rows() %}
    {% if is_incremental() %}
        DELETE FROM {{ this }}
        WHERE row_id NOT IN (
            SELECT 'calendar_' || event_id FROM {{ ref('int_calendar_events') }}
            UNION ALL
            SELECT 'plaid_' || transaction_id FROM {{ ref('int_plaid_transactions') }}
            UNION ALL
            SELECT 'alpaca_' || order_id FROM {{ ref('stg_alpaca_orders') }}
        )
    {% endif %}
{% endmacro %}
