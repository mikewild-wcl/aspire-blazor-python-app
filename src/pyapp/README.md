## Dependencies

This project uses `uv` with [pyproject.toml](pyproject.toml) and [uv.lock](uv.lock).

Set up a folder with a Python virtual environment for your project, and activate the environment.
```
md pyapp
cd pyapp
uv venv --python 3.14
.venv\Scripts\activate.bat
```

To sync dependencies:

```powershell
uv sync
```

3. Verify key packages are installed:

```powershell
uv pip list | Select-String "opentelemetry|fastapi|uvicorn|rich"
```

## TLS certificate note (this machine)

If `uv sync` fails with `invalid peer certificate: UnknownIssuer` for `https://pypi.org`, use:

```powershell
uv sync --allow-insecure-host pypi.org --allow-insecure-host files.pythonhosted.org
```

Use this workaround only in trusted networks. The preferred fix is to install/trust the correct corporate root CA so regular TLS validation works.
