#!/bin/sh
# رفع كامل بأمر واحد: تثبيت + تسجيل دخول (لو لازم) + الجداول + (R2 لو متاح) + نشر + فحص
set -e
cd "$(dirname "$0")"
npm install
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login
npx wrangler d1 execute adwmx --remote --file=./schema.sql || echo "(تخطّي: الجداول هتتنشأ تلقائياً من الـ Worker)"
# R2 اختياري: لو الحساب بيسمح، بنفعّله. وإلا الصور والفويس بتتخزن في D1 وكله شغّال.
if ! grep -q '^\[\[r2_buckets\]\]' wrangler.toml; then
  if npx wrangler r2 bucket create asdle-media >/dev/null 2>&1 || npx wrangler r2 bucket list 2>/dev/null | grep -q asdle-media; then
    printf '\n[[r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "asdle-media"\n' >> wrangler.toml
    echo "✅ تم تفعيل R2 للوسائط"
  else
    echo "ℹ️ R2 غير متاح على الحساب — الوسائط هتتخزن في D1 (شغّال تمام)"
  fi
fi
npx wrangler deploy
node check.mjs
