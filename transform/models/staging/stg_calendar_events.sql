WITH raw_data AS (
    SELECT
        -- Parse extraction timestamp from metadata envelope
        CAST(metadata->>'$.extracted_at' AS TIMESTAMP) AS extracted_at,
        metadata->>'$.run_id' AS run_id,
        -- Unnest the events array from raw_payload using json_transform
        unnest(json_transform(CAST(raw_payload AS JSON)->'$.items', '["JSON"]')) AS event_data
    -- Explicit JSON prevents auto-inference from converting dateTime strings
    -- to UTC and discarding their original offsets before we can preserve them.
    FROM read_json('{{ var("google_calendar_events_path") }}',
                   columns={metadata: 'JSON', raw_payload: 'JSON'})
), event_fields AS (
    SELECT *,
        COALESCE(event_data->>'$.start.dateTime', event_data->>'$.start.date') AS source_start,
        COALESCE(event_data->>'$.end.dateTime', event_data->>'$.end.date') AS source_end,
        event_data->>'$.start.timeZone' AS source_start_zone,
        COALESCE(event_data->>'$.end.timeZone', event_data->>'$.start.timeZone') AS source_end_zone,
        (event_data->>'$.start.dateTime') IS NULL AND (event_data->>'$.start.date') IS NOT NULL AS all_day
    FROM raw_data
)

SELECT
    -- Safely extract event parameters using JSON dot notation
    (event_data->>'$.id') AS event_id,
    (event_data->>'$.status') AS status,
    (event_data->>'$.summary') AS summary,
    (event_data->>'$.description') AS description,
    -- Timed instants are UTC TIMESTAMPs; all-day values remain calendar dates.
    -- Never let the machine/session timezone choose the meaning of a timestamp.
    CASE
        WHEN all_day THEN CAST(source_start AS TIMESTAMP)
        WHEN regexp_matches(source_start, '(Z|[+-][0-9]{2}:[0-9]{2})$')
            THEN timezone('UTC', CAST(source_start AS TIMESTAMPTZ))
        WHEN source_start_zone IS NOT NULL
            THEN timezone('UTC', timezone(source_start_zone, CAST(source_start AS TIMESTAMP)))
        ELSE CAST(source_start AS TIMESTAMP)
    END AS start_time,
    CASE
        WHEN all_day THEN CAST(source_end AS TIMESTAMP)
        WHEN regexp_matches(source_end, '(Z|[+-][0-9]{2}:[0-9]{2})$')
            THEN timezone('UTC', CAST(source_end AS TIMESTAMPTZ))
        WHEN source_end_zone IS NOT NULL
            THEN timezone('UTC', timezone(source_end_zone, CAST(source_end AS TIMESTAMP)))
        ELSE CAST(source_end AS TIMESTAMP)
    END AS end_time,
    source_start,
    source_end,
    source_start_zone,
    source_end_zone,
    all_day,
    (regexp_matches(source_start, '(Z|[+-][0-9]{2}:[0-9]{2})$') OR source_start_zone IS NOT NULL)
    AND (regexp_matches(source_end, '(Z|[+-][0-9]{2}:[0-9]{2})$') OR source_end_zone IS NOT NULL)
        AS time_zone_known,
    (event_data->>'$.organizer.email') AS organizer_email,
    (event_data->>'$.location') AS location,
    extracted_at,
    run_id
FROM event_fields
