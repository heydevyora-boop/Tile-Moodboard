# syntax=docker/dockerfile:1

FROM python:3.11-slim-bookworm

WORKDIR /app

# libgl1/libglib2.0-0: opencv-python (imported by app/image_classifier.py etc.)
# links against libGL at runtime — without these the container boots but
# crashes on the first import with "libGL.so.1: cannot open shared object
# file". PyMuPDF/pillow ship self-contained wheels and need nothing extra.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY main_step6_complete.py ./
COPY app ./app
COPY config ./config
COPY prompts ./prompts

# Deliberately NOT copied: usb_agent.py (Windows-only pendrive watcher —
# uses ctypes.windll, can't run in this container regardless), and the
# v2_test.py/test_google.py/extract_page.py dev scripts, catalog_agent.db,
# test_gemini.jpg — none of them are imported by main_step6_complete.py's
# actual dependency chain (verified with `python3 -c "import
# main_step6_complete"`). .dockerignore excludes the rest (.venv,
# __pycache__, etc.) as a backstop.

EXPOSE 8000

# Same real health check the Node backend's checkPythonAIHealth() polls —
# confirms the FastAPI app actually came up, not just that the process exists.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health', timeout=3).status == 200 else 1)"

CMD ["python3", "-m", "uvicorn", "main_step6_complete:app", "--host", "0.0.0.0", "--port", "8000"]
