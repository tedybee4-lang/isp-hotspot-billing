import os, ast, glob

ROOT = r'c:\Users\brayo\Desktop\isp-hotspot-billing'
out = []

deleted = [
    r'backend\app\api\v1\integrations\mpesa.py',
    r'backend\app\modules\billing\mpesa.py',
    r'backend\app\schemas\mpesa.py',
    r'backend\tests\test_mpesa_api.py',
    r'backend\tests\test_mpesa_integration.py',
    r'backend\tests\test_mpesa_schemas.py',
    r'backend\tests\test_mpesa_service.py',
    r'backend\tests\MPESA_TEST_SUMMARY.md',
]
out.append('--- deleted files (expect all False) ---')
for rel in deleted:
    out.append(f'{os.path.exists(os.path.join(ROOT, rel))}  {rel}')

# syntax check all modified py files
out.append('--- syntax check ---')
check = [
    r'backend\app\api\v1\__init__.py',
    r'backend\app\api\v1\integrations\__init__.py',
    r'backend\app\api\v1\business\billing.py',
    r'backend\app\api\v1\payments\gateways.py',
    r'backend\app\modules\billing\__init__.py',
    r'backend\app\modules\billing\service.py',
    r'backend\app\modules\gateways\service.py',
    r'backend\app\modules\__init__.py',
    r'backend\app\core\config.py',
]
for rel in check:
    p = os.path.join(ROOT, rel)
    try:
        ast.parse(open(p, encoding='utf-8').read())
        out.append(f'OK   {rel}')
    except SyntaxError as e:
        out.append(f'FAIL {rel}: {e}')

# remaining mpesa refs across backend/app (excluding known-historical)
out.append('--- remaining mpesa/Mpesa refs in backend/app (excl. venv) ---')
for dirpath, dirs, files in os.walk(os.path.join(ROOT, 'backend', 'app')):
    dirs[:] = [d for d in dirs if d not in ('.venv', '__pycache__')]
    for fn in files:
        if fn.endswith('.py'):
            p = os.path.join(dirpath, fn)
            try:
                for i, line in enumerate(open(p, encoding='utf-8'), 1):
                    if 'mpesa' in line.lower() or 'daraja' in line.lower():
                        rel = os.path.relpath(p, ROOT)
                        out.append(f'{rel}:{i}: {line.strip()[:90]}')
            except Exception as e:
                out.append(f'ERR {p}: {e}')

open(os.path.join(ROOT, '_helper_out.txt'), 'w', encoding='utf-8').write('\n'.join(out))
print('WROTE _helper_out.txt', len(out), 'lines')
