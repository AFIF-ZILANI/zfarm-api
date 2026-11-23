# ZeroD Farms — Financial Architecture & Profit Allocation

## 1. Entity & Operational Context
- **Entity:** ZeroD Farms (AgriTech & commercial poultry subsidiary of ZeroD; sole proprietorship).
- **Location:** Naogaon, Bangladesh. **Currency:** BDT.
- **Operating model:** Commercial broiler farming (Pakistani Sonali Classic birds) on recurring flock batch cycles (brooder and grower sheds; ~5,000 birds/month output).

## 2. Banking Architecture (Separate Banks)

Money is kept in four separate banks. Each fund has its own bank. They are **not** sub-accounts of one
another. Bank names are deliberately not recorded here; in FMS each is a farm account the owner names.

1. **Operating** — business current account. The primary cash hub.
   - **In:** bird sales revenue, batch settlements.
   - **Out:** direct operating expenses (day-old chicks, feed, medicine/vaccines, litter, utilities, farm staff payroll).
   - **Rule:** net profit is worked out against this account at the close of each batch cycle, before any funds are swept out.

2. **Reinvestment & CapEx** — its own bank, savings account.
   - Retained earnings for farm infrastructure, equipment upgrades (e.g. automated nipple drinker lines, rooftop solar) and scaling flock working capital.

3. **Risk & Tax Reserve** — its own bank, savings account.
   - Ring-fenced liquidity for mortality/disease shocks, sudden feed price spikes, and annual tax/regulatory liabilities.

4. **Owner** — personal account of the founder/General Manager, in its own bank.
   - **In:** strictly the scheduled owner profit draw.
   - **Rule:** zero direct mixing with farm operating expenses or supplier payments.

## 3. Net Profit Allocation Rules (50 / 30 / 20)

On batch settlement (`Net Profit = Gross Batch Revenue − Total Direct & Allocated Operating Costs`),
net profit is swept at these target ratios:

| Share | Goes to | Breakdown |
|---|---|---|
| **50%** Reinvestment & CapEx | Reinvestment & CapEx bank | 30% infrastructure & equipment upgrades; 20% flock capacity expansion & working-capital buffer |
| **30%** Risk & Tax Reserves | Risk & Tax Reserve bank | 20% biosecurity, disease/mortality emergency buffer and feed price shock cushion; 10% income tax & regulatory compliance reserve |
| **20%** Personal Owner Draw | Owner bank | 20% founder/GM salary draw |

## 4. Implementation Guidelines for Code / Ledger Logic
- Model these buckets as explicit funds in the Farm Management System (FMS): Operating, Reinvestment & CapEx, Risk & Tax Reserve, Owner.
- Enforce strict separation between **Operating Cash**, **Restricted Reserves** (CapEx + Risk/Tax) and **Owner Draws**, so available working capital is never overstated.
- Support a configurable percentage override per batch, defaulting to `50 / 30 / 20`.
