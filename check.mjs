// node check.mjs [الرابط]  — يفحص السيرفر والقاعدة والتخزين ورقم المطور
const base = process.argv[2] || 'https://asdle1.jffnco.workers.dev';
const r = await fetch(base + '/ping'); const t = await r.text();
console.log(r.status, t);
try {
  const j = JSON.parse(t);
  console.log(j.ok && j.db ? '✅ السيرفر شغّال والقاعدة تمام (v' + j.version + ')' : '❌ فيه مشكلة: ' + (j.error || 'راجع الإعدادات'));
  console.log('📦 تخزين الصور والفويس: ' + (j.media === 'r2' ? 'R2' : 'D1 (تلقائي)'));
  console.log(j.devConfigured ? '👑 رقم المطور مضبوط' : '⚠️ رقم المطور غير مضبوط (DEVELOPER_PHONE) — صندوق البلاغات وحذف الحسابات مقفولين');
} catch { console.log('❌ الرد مش JSON — الرابط غلط أو محمي بتسجيل دخول'); }
