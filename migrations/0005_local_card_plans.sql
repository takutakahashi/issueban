CREATE TABLE workspace_card_plans (
  card_id INTEGER PRIMARY KEY REFERENCES workspace_cards(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspace_card_plan_item_links (
  card_id INTEGER NOT NULL REFERENCES workspace_cards(id) ON DELETE CASCADE,
  item_digest TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  target_issue_id INTEGER NOT NULL,
  target_repository TEXT NOT NULL,
  target_issue_number INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (card_id, item_digest)
);
CREATE INDEX workspace_card_plan_links_card ON workspace_card_plan_item_links(card_id);
CREATE INDEX workspace_card_plan_links_target ON workspace_card_plan_item_links(target_repository, target_issue_number);
