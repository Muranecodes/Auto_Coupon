# Auto_Coupon

Automated discovery, extraction, and batch wallet redemption of Taiwan foodpanda and Uber Eats promotional codes across mobile and desktop browsers.

## Language

**Platform** (`外送平台`):
A supported food delivery service (`foodpanda` or `ubereats` in Taiwan) where coupons are redeemed.
_Avoid_: Store, merchant, provider, site

**Coupon** (`優惠碼`):
A promotional code string (Traditional Chinese, alphanumeric, or mixed) issued for a Platform, paired with its discount conditions and expiration date.
_Avoid_: Promo, voucher, discount, ticket

**Wallet Coupon** (`歸戶型優惠碼`):
A Coupon that can be bound ahead of time into a user's account wallet on a Platform's promotions page and subsequently applied inside the native mobile app.
_Avoid_: Pre-claim code, account voucher, general promo

**Checkout Coupon** (`結帳限定碼`):
A Coupon (such as bank credit-card partner codes or restaurant-specific codes) that cannot be bound in the account wallet ahead of time and is only accepted at order checkout.
_Avoid_: Cart code, payment code, manual promo

**Coupon Feed** (`遠端優惠碼清單`):
The structured, periodically updated catalog of active Coupons published by the repository for one-click synchronization.
_Avoid_: Remote database, coupon pool, cloud list

**Candidate Chip** (`候選優惠碼標籤`):
An interactive preview token produced by parsing freeform text, allowing the user to toggle or remove extracted strings before starting a Redemption Run.
_Avoid_: Parsed tag, preview item, token pill

**Redemption Run** (`批次歸戶作業`):
A sequential execution that submits selected Wallet Coupons one by one into a Platform's wallet page and records each outcome.
_Avoid_: Batch job, claim queue, automation session

**Redemption Record** (`歸戶紀錄`):
The remembered outcome (`claimed`, `already_claimed`, or `invalid_or_expired`) of attempting a specific Coupon on a Platform for the current browser profile, used to skip redundant attempts in future runs.
_Avoid_: History log, attempt cache, status entry
