"""Build only reviewed public assets and environment-derived browser configuration."""
from pathlib import Path
import shutil
import subprocess
import sys
root = Path(__file__).resolve().parents[1]
output = root / 'dist'
if output.exists():
    shutil.rmtree(output)
output.mkdir()
for relative in ['about-this-project.html', 'ai-referrals.js', 'content.json', 'llms.txt', 'posthog-bootstrap.js', 'robots.txt', 'sitemap.xml', 'index.html', 'app.js', 'styles.css', 'assets']:
    source = root / relative
    if not source.exists():
        continue
    target = output / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, target)
    else:
        shutil.copy2(source, target)
subprocess.run([sys.executable, str(root / 'scripts/configure-posthog.py'), '--output', str(output / 'posthog-config.js'), '--root', str(root)], check=True)
print('Public site built.')
