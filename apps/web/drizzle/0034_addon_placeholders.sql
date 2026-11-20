-- Add-on placeholders (Jason, 27 September 2026): on the Pricing page with no price until an admin sets one.
INSERT INTO "addon_price" ("key", "name", "price_cents", "quoted", "sort_order") VALUES
  ('domain_purchase', 'Domain purchase (registered in the client''s name)', NULL, false, 8),
  ('extra_pages', 'Extra pages', NULL, false, 9),
  ('subdomain_site', 'Subdomain site or ad landing page', NULL, false, 10),
  ('extra_concept', 'Extra design concept', NULL, false, 11),
  ('stock_photos', 'Licensed stock photos', NULL, false, 12),
  ('rush_delivery', 'Rush delivery', NULL, false, 13)
ON CONFLICT ("key") DO NOTHING;
