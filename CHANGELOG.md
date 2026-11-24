# Changelog

## 0.1.0

Initial release.

- PostgreSQL, MySQL/MariaDB and SQLite support behind one connection string.
- Tools: `list_schemas`, `list_tables`, `describe_table`, `sample_rows`, `query`, and (opt-in) `execute`.
- Read-only by default; SQL guard plus engine-level read-only enforcement.
- Row cap, statement timeout, parameterised queries, credential-scrubbed errors.
