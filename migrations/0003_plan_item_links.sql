CREATE TABLE plan_item_links (
  source_issue_id INTEGER NOT NULL,
  item_digest TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  target_issue_id INTEGER NOT NULL,
  target_repository TEXT NOT NULL,
  target_issue_number INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_issue_id, item_digest)
);
CREATE INDEX plan_item_links_source ON plan_item_links(source_issue_id);
CREATE INDEX plan_item_links_target ON plan_item_links(target_repository, target_issue_number);
