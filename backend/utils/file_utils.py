from pathlib import Path
import os
from typing import Optional


def ensure_directory(path: str) -> Path:
    """
    Ensure directory exists, create if necessary.

    Args:
        path: Directory path

    Returns:
        Path object
    """
    dir_path = Path(path)
    dir_path.mkdir(parents=True, exist_ok=True)
    return dir_path


def get_file_size(filepath: str) -> Optional[float]:
    """
    Get file size in MB.

    Args:
        filepath: Path to file

    Returns:
        File size in MB, or None if file doesn't exist
    """
    try:
        return os.path.getsize(filepath) / (1024 ** 2)
    except FileNotFoundError:
        return None


def get_directory_size(dirpath: str) -> float:
    """
    Get total size of directory in MB.

    Args:
        dirpath: Path to directory

    Returns:
        Total size in MB
    """
    total = 0
    try:
        for dirpath, dirnames, filenames in os.walk(dirpath):
            for filename in filenames:
                filepath = os.path.join(dirpath, filename)
                if os.path.exists(filepath):
                    total += os.path.getsize(filepath)
    except Exception:
        pass

    return total / (1024 ** 2)


def list_files(dirpath: str, extension: str = None) -> list:
    """
    List files in directory.

    Args:
        dirpath: Directory path
        extension: Optional file extension filter (e.g., ".png")

    Returns:
        List of file paths
    """
    try:
        dir_path = Path(dirpath)
        if extension:
            return [str(f) for f in dir_path.glob(f"*{extension}")]
        return [str(f) for f in dir_path.glob("*") if f.is_file()]
    except Exception:
        return []
