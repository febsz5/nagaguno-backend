-- 007_payment_method.sql
--
-- Real, new feature: buyer chooses Cash on Delivery or Online Payment
-- when placing an order. COD needs no payment proof at all; Online
-- Payment requires the existing proof-upload flow, and the seller
-- cannot confirm an Online Payment order until that proof is
-- verified (previously, proof_status existed but nothing in the
-- order-status transition logic actually checked it before allowing
-- a seller to confirm -- this closes that gap too).

CREATE TYPE payment_method AS ENUM ('cod', 'online');

ALTER TABLE orders ADD COLUMN payment_method payment_method NOT NULL DEFAULT 'cod';