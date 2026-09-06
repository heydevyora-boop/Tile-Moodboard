# Vercel serverless entry point for the FastAPI AI-visualization service.
#
# main_step6_complete.py is the process entry point for Docker (it calls
# uvicorn.run() under an `if __name__ == "__main__"` guard when executed
# directly). Vercel's Python runtime instead looks for an ASGI `app`
# object in a file under api/, so this module just adds the package's
# real location to sys.path and re-exports that same FastAPI instance.
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from main_step6_complete import app  # noqa: E402  (import after sys.path fix)

# vercel.json routes /pyapi/(.*) here and hands the function the original,
# still-prefixed path, so FastAPI saw /pyapi/internal/visualizations while its
# routes are registered at /internal/visualizations -- every request came back
# 404 {"detail":"Not Found"}. Declaring the mount point lets Starlette strip
# the prefix before matching. It compares the prefix rather than assuming it,
# so an unprefixed path still routes normally and Docker, which serves this
# same app object at the root, is unaffected.
app.root_path = "/pyapi"
