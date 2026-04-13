from flask import Flask, render_template, request, jsonify, session, redirect, url_for  # type: ignore
from flask_cors import CORS  # type: ignore
from werkzeug.security import generate_password_hash, check_password_hash  # type: ignore
import whisper  # type: ignore
from transformers import pipeline  # type: ignore
import sqlite3, os, requests, functools, datetime # type: ignore
import os 
app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "change-me-in-production-xyz987")
CORS(app)

DB_PATH            = "users.db"
ALLOWED_EXTENSIONS = {"mp3", "wav", "m4a", "ogg", "flac", "webm"}

# ── DB bootstrap ────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT    NOT NULL,
                email      TEXT    NOT NULL UNIQUE,
                password   TEXT    NOT NULL,
                role       TEXT    NOT NULL DEFAULT 'user',
                created_at TEXT    NOT NULL DEFAULT (datetime('now'))
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS transcripts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL,
                text       TEXT    NOT NULL,
                sentiment  TEXT,
                created_at TEXT    NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)
        # seed admin account (change password in production!)
        existing = db.execute("SELECT id FROM users WHERE email = 'admin@voiceai.com'").fetchone()
        if not existing:
            db.execute(
                "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
                ("Admin", "admin@voiceai.com", generate_password_hash("admin123"), "admin")
            )
        db.commit()

init_db()

# ── load AI models ──────────────────────────────────────────────────────────
print("Loading Whisper model…")
whisper_model = whisper.load_model("base")
print("Loading sentiment model…")
sentiment_pipeline = pipeline("sentiment-analysis")
print("All models loaded.")

# ── helpers ─────────────────────────────────────────────────────────────────
def login_required(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return decorated

def admin_required(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session or session.get("role") != "admin":
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return decorated

def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS

def normalize_sentiment(label):
    label = label.upper()
    if label == "POSITIVE": return "positive"
    if label == "NEGATIVE": return "negative"
    return "neutral"

# ── page routes ─────────────────────────────────────────────────────────────
@app.route("/")
def index():
    if "user_id" not in session:
        return redirect(url_for("login_page"))
    return render_template("index.html", user_name=session.get("name", "User"))

@app.route("/login")
def login_page():
    if "user_id" in session:
        return redirect(url_for("index"))
    return render_template("login.html")

@app.route("/register")
def register_page():
    if "user_id" in session:
        return redirect(url_for("index"))
    return render_template("register.html")

@app.route("/admin")
@admin_required
def admin_page():
    return render_template("admin.html")

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login_page"))

# ── auth API ─────────────────────────────────────────────────────────────────
@app.route("/api/register", methods=["POST"])
def api_register():
    data = request.get_json()
    name     = (data.get("name")     or "").strip()
    email    = (data.get("email")    or "").strip().lower()
    password = (data.get("password") or "").strip()

    if not name or not email or not password:
        return jsonify({"error": "All fields are required."}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters."}), 400

    try:
        with get_db() as db:
            db.execute(
                "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
                (name, email, generate_password_hash(password))
            )
            db.commit()
        return jsonify({"message": "Account created successfully."})
    except sqlite3.IntegrityError:
        return jsonify({"error": "An account with that email already exists."}), 409

@app.route("/api/login", methods=["POST"])
def api_login():
    data     = request.get_json()
    email    = (data.get("email")    or "").strip().lower()
    password = (data.get("password") or "").strip()

    with get_db() as db:
        user = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()

    if not user or not check_password_hash(user["password"], password):
        return jsonify({"error": "Invalid email or password."}), 401

    session["user_id"] = user["id"]
    session["name"]    = user["name"]
    session["role"]    = user["role"]
    return jsonify({"message": "Login successful.", "role": user["role"]})

# ── admin API ─────────────────────────────────────────────────────────────────
@app.route("/api/admin/users")
@admin_required
def api_admin_users():
    with get_db() as db:
        users = db.execute(
            "SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC"
        ).fetchall()
        counts = db.execute(
            "SELECT user_id, COUNT(*) as cnt FROM transcripts GROUP BY user_id"
        ).fetchall()

    count_map = {r["user_id"]: r["cnt"] for r in counts}
    return jsonify([
        {
            "id": u["id"], "name": u["name"], "email": u["email"],
            "role": u["role"], "created_at": u["created_at"],
            "transcripts": count_map.get(u["id"], 0)
        }
        for u in users
    ])

@app.route("/api/admin/users/<int:uid>", methods=["DELETE"])
@admin_required
def api_admin_delete_user(uid):
    if uid == session["user_id"]:
        return jsonify({"error": "Cannot delete your own account."}), 400
    with get_db() as db:
        db.execute("DELETE FROM transcripts WHERE user_id = ?", (uid,))
        db.execute("DELETE FROM users WHERE id = ?", (uid,))
        db.commit()
    return jsonify({"message": "User deleted."})

@app.route("/api/admin/stats")
@admin_required
def api_admin_stats():
    with get_db() as db:
        total_users       = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        total_transcripts = db.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0]
        today             = datetime.date.today().isoformat()
        new_today         = db.execute(
            "SELECT COUNT(*) FROM users WHERE created_at LIKE ?", (today + "%",)
        ).fetchone()[0]
    return jsonify({
        "total_users": total_users,
        "total_transcripts": total_transcripts,
        "new_today": new_today
    })

# ── speech / sentiment / translate ───────────────────────────────────────────
@app.route("/upload", methods=["POST"])
@login_required
def upload():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400
    audio = request.files["audio"]
    if audio.filename == "" or not allowed_file(audio.filename):
        return jsonify({"error": "Unsupported file type."}), 400

    os.makedirs("temp_audio", exist_ok=True)
    temp_path = os.path.join("temp_audio", audio.filename)
    audio.save(temp_path)

    try:
        result     = whisper_model.transcribe(temp_path)
        transcript = result["text"].strip()
        sr         = sentiment_pipeline(transcript[:512])
        raw_label  = sr[0]["label"]
        score      = round(sr[0]["score"] * 100)
        label      = normalize_sentiment(raw_label)

        with get_db() as db:
            db.execute(
                "INSERT INTO transcripts (user_id, text, sentiment) VALUES (?, ?, ?)",
                (session["user_id"], transcript, label)
            )
            db.commit()

        return jsonify({
            "transcript": transcript,
            "sentiment": {"label": label, "meta": "Confidence: " + str(score) + "%"}
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

@app.route("/sentiment", methods=["POST"])
@login_required
def sentiment():
    data = request.get_json()
    if not data or "text" not in data:
        return jsonify({"error": "No text provided"}), 400
    text = data["text"]
    try:
        result    = sentiment_pipeline(text[:512])
        raw_label = result[0]["label"]
        score     = round(result[0]["score"] * 100)
        label     = normalize_sentiment(raw_label)

        with get_db() as db:
            db.execute(
                "INSERT INTO transcripts (user_id, text, sentiment) VALUES (?, ?, ?)",
                (session["user_id"], text, label)
            )
            db.commit()

        return jsonify({"sentiment": {"label": label, "meta": "Confidence: " + str(score) + "%"}})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/translate", methods=["POST"])
@login_required
def translate():
    data        = request.get_json()
    text        = (data.get("text")        or "").strip()
    target_lang = (data.get("target_lang") or "").strip()
    source_lang = data.get("source_lang", "en")

    if not text or not target_lang:
        return jsonify({"error": "Missing text or target_lang"}), 400

    try:
        resp = requests.get(
            "https://api.mymemory.translated.net/get",
            params={"q": text, "langpair": f"{source_lang}|{target_lang}"},
            timeout=10
        )
        resp.raise_for_status()
        result     = resp.json()
        translated = result.get("responseData", {}).get("translatedText", "")
        status     = result.get("responseStatus", 500)
        if status != 200 or not translated:
            return jsonify({"error": result.get("responseDetails", "Translation failed")}), 500
        return jsonify({"translated_text": translated, "source_lang": source_lang, "target_lang": target_lang})
    except requests.exceptions.Timeout:
        return jsonify({"error": "Translation service timed out."}), 504
    except Exception as e:
        return jsonify({"error": str(e)}), 500
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 7860)))
