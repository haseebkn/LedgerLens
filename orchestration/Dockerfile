FROM quay.io/astronomer/astro-runtime:11.3.0

# Astro's ONBUILD hooks install packages.txt and requirements.txt and copy the
# DAGs. Keep the runtime's own non-root user; no extra system packages are needed.

# Keep dbt's protobuf/OpenTelemetry dependencies out of Airflow's provider env.
RUN python -m venv /usr/local/airflow/dbt-venv \
    && /usr/local/airflow/dbt-venv/bin/pip install --no-cache-dir -r requirements-dbt.txt
