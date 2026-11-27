Overview
========

LedgerLens ingestion recovery
----------------------------

The image installs `pydantic-settings` because extraction imports the shared
`config.settings` module. Astro's base-image hooks install `requirements.txt`;
the Dockerfile keeps Astro's default non-root user. The dbt versions in
`requirements-dbt.txt` are bounded to Core 1.10 and DuckDB adapter 1.10 to support
the repository's generic-test `arguments:` syntax. dbt runs from its own
`/usr/local/airflow/dbt-venv` so its protobuf/OpenTelemetry dependencies cannot
replace Airflow's provider dependencies.

Build the image from this directory:

```powershell
docker build -t ledgerlens-airflow:pydantic-settings-20261014 .
```

Extraction and dbt tasks have explicit working directories under the mounted
project. A configured source failure now returns a nonzero exit status, so
Airflow retries it instead of marking incomplete ingestion successful. Scheduled
Google authentication is non-interactive; renew `token.json` locally if Google
returns `invalid_grant`. Plaid `ITEM_LOGIN_REQUIRED` requires reconnecting the
existing sandbox Item through Link update mode.

Do not resume the live scheduler until those connections pass an extraction
check. Keep the existing Airflow PostgreSQL and log volumes: they retain prior
run history and pending retries. Port 8080 is occupied by another project on
this machine, so select an unused local UI port when resuming Astro.

Private recovery logs and fixture verification data live under
`tmp/airflow-recovery/` in the parent project and are ignored by Git. Fixture runs
are separate from live-provider verification and disable S3 uploads.

Verified October 14, 2026: image `ledgerlens-airflow:pydantic-settings-20261014`
imports the shared settings, all extractors, and the DAG; 56 relevant ingestion
and DAG tests pass in that image. A real scheduler-created fixture run
(`scheduled__2026-10-13T00:00:00+00:00`) completed all three tasks successfully,
including 10 dbt models and 22 data tests. S3 was unconfigured and its task took
the explicit no-upload path. This does not establish successful live Calendar
or Plaid ingestion: they returned `invalid_grant` and `ITEM_LOGIN_REQUIRED`,
respectively. Live Alpaca paper extraction succeeded. Authentication renewal was
deferred by the user, and the live scheduler remains stopped.

The dbt environment passes `pip check`. Airflow's original Astro 11.3.0 base
retains its pre-existing `gcloud-aio-auth` / `cryptography` version warning; the
recovery does not introduce additional provider dependency conflicts.

Welcome to Astronomer! This project was generated after you ran 'astro dev init' using the Astronomer CLI. This readme describes the contents of the project, as well as how to run Apache Airflow on your local machine.

Project Contents
================

Your Astro project contains the following files and folders:

- dags: This folder contains the Python files for your Airflow DAGs. By default, this directory includes one example DAG:
    - `example_astronauts`: This DAG shows a simple ETL pipeline example that queries the list of astronauts currently in space from the Open Notify API and prints a statement for each astronaut. The DAG uses the TaskFlow API to define tasks in Python, and dynamic task mapping to dynamically print a statement for each astronaut. For more on how this DAG works, see our [Getting started tutorial](https://www.astronomer.io/docs/learn/get-started-with-airflow).
- Dockerfile: This file contains a versioned Astro Runtime Docker image that provides a differentiated Airflow experience. If you want to execute other commands or overrides at runtime, specify them here.
- include: This folder contains any additional files that you want to include as part of your project. It is empty by default.
- packages.txt: Install OS-level packages needed for your project by adding them to this file. It is empty by default.
- requirements.txt: Install Python packages needed for your project by adding them to this file. It is empty by default.
- plugins: Add custom or community plugins for your project to this file. It is empty by default.
- airflow_settings.yaml: Use this local-only file to specify Airflow Connections, Variables, and Pools instead of entering them in the Airflow UI as you develop DAGs in this project.

Deploy Your Project Locally
===========================

Start Airflow on your local machine by running 'astro dev start'.

This command will spin up five Docker containers on your machine, each for a different Airflow component:

- Postgres: Airflow's Metadata Database
- Scheduler: The Airflow component responsible for monitoring and triggering tasks
- DAG Processor: The Airflow component responsible for parsing DAGs
- API Server: The Airflow component responsible for serving the Airflow UI and API
- Triggerer: The Airflow component responsible for triggering deferred tasks

When all five containers are ready the command will open the browser to the Airflow UI at http://localhost:8080/. You should also be able to access your Postgres Database at 'localhost:5432/postgres' with username 'postgres' and password 'postgres'.

Note: If you already have either of the above ports allocated, you can either [stop your existing Docker containers or change the port](https://www.astronomer.io/docs/astro/cli/troubleshoot-locally#ports-are-not-available-for-my-local-airflow-webserver).

Deploy Your Project to Astronomer
=================================

If you have an Astronomer account, pushing code to a Deployment on Astronomer is simple. For deploying instructions, refer to Astronomer documentation: https://www.astronomer.io/docs/astro/deploy-code/

Contact
=======

The Astronomer CLI is maintained with love by the Astronomer team. To report a bug or suggest a change, reach out to our support.
