CREATE SCHEMA demo;
CREATE TABLE demo.widgets (
  id   serial PRIMARY KEY,
  name text NOT NULL UNIQUE
);
