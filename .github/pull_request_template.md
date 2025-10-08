## 🚀 Summary
Briefly explain what this PR changes or adds.
- Example: “Adds new /api/admin/loans endpoint with full guard coverage and dashboard integration.”

## ✅ Checklist
Before requesting review, confirm all checks pass:

- [ ] `npm run check:deadcode` → ✅ No banned patterns or missing guards
- [ ] `npm run seed:ussd-pool` (if schema changed)
- [ ] `npm run test:e2e` → passes all tests
- [ ] CI pipeline → green ✅
- [ ] Manually tested affected dashboards or USSD flows
- [ ] Added/updated documentation (if new endpoints)

## 🔒 Security / Auth
- All `/api/admin/*` routes protected by `requireAdmin`.
- All `/u/*` routes protected by `requireUser`.
- All `/u/sacco/:saccoId/*` routes protected by both `requireUser` and `requireSaccoMember`.

## 🧩 Notes for Reviewers
(Optional)
Add any context, related PRs, or deployment notes.

## 🧠 Static Checks Summary (auto)
This PR automatically runs:
- Dead-code / banned-word guard
- Duplicate route detection
- Auth guard verification
- Membership guard enforcement

