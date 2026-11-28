SELECT
    event_id,
    status,
    summary,
    description,
    start_time,
    end_time,
    source_start,
    source_end,
    source_start_zone,
    source_end_zone,
    all_day,
    time_zone_known,
    organizer_email,
    location,
    extracted_at,
    run_id
FROM {{ ref('stg_calendar_events') }}
-- Keep only the freshest version of each event to guarantee idempotency
QUALIFY ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY extracted_at DESC) = 1
