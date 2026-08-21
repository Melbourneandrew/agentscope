CREATE INDEX traces_trace_id_lookup
  ON traces(trace_id, delivery_identity);

CREATE INDEX traces_retention_order
  ON traces(admission_time_sort_key ASC, delivery_identity ASC);
