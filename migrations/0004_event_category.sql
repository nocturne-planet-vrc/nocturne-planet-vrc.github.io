ALTER TABLE events ADD COLUMN category TEXT NOT NULL DEFAULT '通常営業' CHECK(length(category) BETWEEN 1 AND 24);
