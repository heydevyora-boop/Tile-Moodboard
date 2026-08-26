from app.gemini_service import analyze_text


result = analyze_text(
    "Reply with exactly: GEMINI CONNECTED"
)

print(result)