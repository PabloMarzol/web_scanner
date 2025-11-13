import os
import tiktoken

ENCODER = tiktoken.encoding_for_model("gpt-4o")
IGNORE_DIRS = {"node_modules", ".git", "venv", "__pycache__", "dist", "build"}

def find_project_root(start_path: str = None) -> str:
    """Walk up directories until a project root marker is found."""
    current_dir = start_path or os.getcwd()
    root_markers = {".git", "package.json", "pyproject.toml", "requirements.txt"}

    while current_dir != os.path.dirname(current_dir):  # stop at filesystem root
        for marker in root_markers:
            if os.path.exists(os.path.join(current_dir, marker)):
                print(f"📁 Detected project root: {current_dir}")
                return current_dir
        current_dir = os.path.dirname(current_dir)

    print("⚠️ Could not find project root, using current directory.")
    return os.getcwd()

def count_tokens_in_file(file_path: str) -> int:
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        return len(ENCODER.encode(content))
    except Exception as e:
        print(f"⚠️ Skipped {file_path}: {e}")
        return 0

def count_tokens_in_repo(root_dir: str) -> None:
    total_tokens = 0
    file_token_map = {}

    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS]

        for filename in filenames:
            if filename.endswith((".py", ".js", ".ts", ".tsx", ".json", ".md")):
                file_path = os.path.join(dirpath, filename)
                tokens = count_tokens_in_file(file_path)
                file_token_map[file_path] = tokens
                total_tokens += tokens

    print("\n📊 Token Analysis Summary:")
    print(f"Total files analyzed: {len(file_token_map)}")
    print(f"Total tokens (approx): {total_tokens:,}")

    top_files = sorted(file_token_map.items(), key=lambda x: x[1], reverse=True)[:10]
    print("\nTop 10 largest files by token count:")
    for path, count in top_files:
        print(f"{path} → {count:,} tokens")

if __name__ == "__main__":
    project_root = find_project_root()
    count_tokens_in_repo(project_root)
