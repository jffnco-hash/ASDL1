// إعادة تعيين كلمة سر أي حساب (مثلاً حساب المطور) لو نسيتها — من غير ما تدخل التطبيق.
// الاستخدام:   node reset_password.mjs 01012345678 "كلمة-السر-الجديدة"          (يطبع الأمر فقط)
//              node reset_password.mjs 01012345678 "كلمة-السر-الجديدة" --run    (ينفّذه على D1 مباشرة)
// لازم تكون عامل  npx wrangler login  قبلها. كلمة السر 6 أحرف على الأقل.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const [, , rawPhone, pass, flag] = process.argv;
if (!rawPhone || !pass) { console.error('الاستخدام: node reset_password.mjs <رقم-الهاتف> <كلمة-السر-الجديدة> [--run]'); process.exit(1); }
if (pass.length < 6) { console.error('كلمة السر لازم تكون 6 أحرف على الأقل'); process.exit(1); }

const phone = rawPhone.replace(/[^0-9+]/g, '').slice(0, 20);
const last10 = phone.replace(/\D/g, '').slice(-10);
if (last10.length < 9) { console.error('رقم الهاتف غير صالح'); process.exit(1); }

// نفس خوارزمية الـ Worker بالضبط: PBKDF2-SHA256 / 100000 تكرار / salt نصي من 32 حرف hex
const salt = randomBytes(16).toString('hex');
const hash = pbkdf2Sync(pass, salt, 100000, 32, 'sha256').toString('hex');
// token=NULL يفصل الأجهزة المسجّلة حالياً، وتدخل بالكلمة الجديدة.
const sql = `UPDATE users SET pass_hash='${hash}', pass_salt='${salt}', token=NULL WHERE substr(phone,-10)='${last10}'`;
const args = ['wrangler', 'd1', 'execute', 'adwmx', '--remote', '--command', sql];

if (flag === '--run') {
  const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(r.status ?? 1);
}
console.log('نفّذ الأمر ده من مجلد server:\n');
console.log(`npx wrangler d1 execute adwmx --remote --command "${sql}"`);
