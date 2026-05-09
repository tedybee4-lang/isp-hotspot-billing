# Contributing to Ultrafaiba ISP Hotspot Billing System

First off — **thank you** for taking the time to contribute! 🎉

This project helps ISPs across Africa manage hotspot billing without building everything from scratch. Your contribution directly helps small internet providers and their customers.

---

## 🚀 Quick Start for Contributors

```bash
git clone https://github.com/Jobkizz/isp-hotspot-billing.git
cd isp-hotspot-billing
npm install
npm run dev
```

Open `http://localhost:5173` — the full system runs with mock data, no backend needed.

---

## 🔥 High-Impact Areas (Pick One and Start!)

These are the features the community wants most — PRs for these get merged fast:

| Priority | Feature | Difficulty |
|---|---|---|
| 🔴 High | Airtel Money / MTN MoMo payment gateway | Medium |
| 🔴 High | Supabase / Firebase backend integration | Hard |
| 🟡 Medium | Vitest unit tests for billing logic | Easy |
| 🟡 Medium | Swahili language (i18n) support | Easy |
| 🟢 Low | More RouterOS script templates | Easy |
| 🟢 Low | CSV export for vouchers & invoices | Easy |

---

## 📋 How to Submit a PR

1. **Fork** the repository
2. Create a feature branch:
   ```bash
   git checkout -b feature/airtel-money-integration
   ```
3. Make your changes following the code style below
4. Test everything:
   ```bash
   npm run dev       # Check it works
   npm run build     # Check it builds without errors
   npx tsc --noEmit  # Check TypeScript passes
   ```
5. Commit with a clear message (we use [Conventional Commits](https://www.conventionalcommits.org/)):
   ```bash
   git commit -m "feat: add Airtel Money payment gateway"
   git commit -m "fix: voucher expiry not clearing sessions"
   git commit -m "docs: add MTN MoMo setup guide"
   ```
6. Push and open a Pull Request — fill in the PR template

---

## 🎨 Code Style

- **TypeScript** is required for all `.tsx` / `.ts` files — no `any` types
- **Functional React components** with hooks only
- **TailwindCSS** for all styling — no inline style objects unless absolutely necessary
- **Lucide React** for all icons — do not add new icon libraries
- Keep components **single-responsibility** — one component = one purpose
- Props interfaces must be **explicitly typed** at the top of each file

---

## 🐛 Reporting Bugs

Use the **[Bug Report template](.github/ISSUE_TEMPLATE/bug_report.yml)** — it asks for exactly what we need to fix things fast.

## 💡 Suggesting Features

Use the **[Feature Request template](.github/ISSUE_TEMPLATE/feature_request.yml)** — tell us the ISP use case, not just the feature.

---

## 💬 Questions?

- **GitHub Discussions** — for general questions & ideas
- **Email** — support@ultrafaiba.net for private queries

---

<div align="center">

Made with ❤️ in Kenya 🇰🇪 — contributions from anywhere in the world are welcome!

</div>
