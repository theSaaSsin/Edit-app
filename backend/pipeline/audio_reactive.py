"""
Audio-reactive drive signals: band energy envelopes and onset detection.

Produces a per-video-frame value in [0, 1] that FX and typography can scale
against, derived from the actual track rather than a synthetic pulse.

Method note, because it is easy to get this wrong in a way that looks right:
the envelope comes from a **short-time** analysis — the signal is cut into
per-frame hops and the band energy of each hop is measured. A single whole-file
FFT with the out-of-band bins zeroed is a global brick-wall filter, not a
time-varying envelope; it tells you how much bass the track contains overall,
not when the kicks land. Similarly, `scipy.signal.hilbert` over a whole track
allocates several complex128 arrays the length of the audio (~130 MB per array
for three minutes at 44.1 kHz), which is a large cost for information the STFT
already gives.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

#: Frequency bands worth driving animation from.
BANDS = {
    "sub_bass": (20.0, 60.0),     # 808s, deep kicks
    "bass": (60.0, 160.0),        # kick body, bass guitar
    "low_mid": (160.0, 500.0),    # snare body, low vocals
    "mid": (500.0, 2000.0),       # vocals, melody
    "high": (2000.0, 8000.0),     # hats, snare crack, sibilance
    "full": (20.0, 20000.0),      # overall loudness
}

#: Minimum normalised flux step that counts as a real transient. Below this a
#: band is treated as having no hits rather than being amplified into noise.
MIN_TRANSIENT_FLUX = 0.08


class AudioUnavailable(RuntimeError):
    """Raised when audio cannot be decoded."""


def _decode_to_wav(path: Path, target_rate: int = 22050) -> Tuple[np.ndarray, int]:
    """
    Decode any audio or video file to mono float samples via ffmpeg.

    `scipy.io.wavfile` only reads WAV, which would exclude mp3, m4a and the
    audio track of a video — the formats actually to hand. ffmpeg handles all of
    them and downmixes to mono at a reduced rate, which is ample since the
    highest band of interest is 8 kHz.
    """
    if not shutil.which("ffmpeg"):
        raise AudioUnavailable(
            "ffmpeg is required to decode audio.\n"
            "  Debian/Ubuntu:  sudo apt install ffmpeg\n"
            "  macOS:          brew install ffmpeg"
        )

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "audio.wav"
        result = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1",
             "-ar", str(target_rate), "-vn", "-y", str(out)],
            capture_output=True, text=True, timeout=600,
        )
        if result.returncode != 0 or not out.exists():
            raise AudioUnavailable(f"ffmpeg could not decode {path.name}: {result.stderr.strip()[:200]}")

        with wave.open(str(out), "rb") as wav:
            rate = wav.getframerate()
            width = wav.getsampwidth()
            raw = wav.readframes(wav.getnframes())

    dtype = {1: np.uint8, 2: np.int16, 4: np.int32}.get(width)
    if dtype is None:
        raise AudioUnavailable(f"unsupported sample width {width}")

    samples = np.frombuffer(raw, dtype=dtype).astype(np.float32)
    if dtype is np.uint8:
        samples = (samples - 128.0) / 128.0
    else:
        samples /= float(np.iinfo(dtype).max)

    if samples.size == 0:
        raise AudioUnavailable(f"{path.name} contains no audio samples")

    return samples, rate


def band_envelope(
    audio_path: str,
    frame_count: int,
    fps: float,
    band: str = "bass",
    smooth: int = 3,
) -> np.ndarray:
    """
    Per-video-frame energy of `band`, normalised to [0, 1].

    One analysis window per video frame, so the result indexes directly by frame
    number with no resampling step to get wrong.

    Returns an array of exactly `frame_count` values.
    """
    if band not in BANDS:
        raise ValueError(f"unknown band {band!r}; known: {sorted(BANDS)}")
    if frame_count <= 0:
        raise ValueError(f"frame_count must be positive, got {frame_count}")
    if fps <= 0:
        raise ValueError(f"fps must be positive, got {fps}")

    samples, rate = _decode_to_wav(Path(audio_path))
    low, high = BANDS[band]

    hop = max(1, int(round(rate / fps)))
    window = min(len(samples), max(hop * 2, 1024))

    # Pad so every video frame has a full window available.
    needed = hop * frame_count + window
    if len(samples) < needed:
        samples = np.pad(samples, (0, needed - len(samples)))

    taper = np.hanning(window).astype(np.float32)
    freqs = np.fft.rfftfreq(window, 1.0 / rate)
    band_bins = (freqs >= low) & (freqs <= high)
    if not band_bins.any():
        raise ValueError(f"band {band!r} has no bins at {rate} Hz sample rate")

    energies = np.empty(frame_count, dtype=np.float32)
    for i in range(frame_count):
        chunk = samples[i * hop: i * hop + window]
        spectrum = np.abs(np.fft.rfft(chunk * taper))
        # RMS across in-band bins: level, independent of how wide the band is.
        energies[i] = np.sqrt(np.mean(spectrum[band_bins] ** 2))

    if smooth > 1:
        kernel = np.ones(smooth, dtype=np.float32) / smooth
        energies = np.convolve(energies, kernel, mode="same")

    peak = float(energies.max())
    if peak <= 1e-9:
        logger.warning("no energy found in the %s band; returning zeros", band)
        return np.zeros(frame_count, dtype=np.float32)

    return (energies / peak).astype(np.float32)


def onset_envelope(
    audio_path: str,
    frame_count: int,
    fps: float,
    band: str = "bass",
    decay: float = 0.6,
) -> np.ndarray:
    """
    Percussive-hit envelope: rises sharply on transients, decays smoothly.

    Built from spectral flux — the positive frame-to-frame *increase* in band
    energy — because a sustained bass note holds energy high without being a
    hit, and scaling FX off raw level makes everything pulse continuously
    instead of on the beat.

    `decay` (0-1) sets how long a hit rings; higher holds longer.
    """
    level = band_envelope(audio_path, frame_count, fps, band=band, smooth=1)

    flux = np.diff(level, prepend=level[0])
    flux = np.maximum(flux, 0.0)  # rises only

    peak = float(flux.max())

    # Normalising by the peak alone turns a band with no transients into
    # full-scale noise: constant hiss has a tiny but non-zero flux, and dividing
    # by its own maximum stretches that to 1.0. `level` is already scaled to
    # [0, 1], so a genuine hit produces a flux step of real size while a steady
    # band stays far below this floor.
    if peak < MIN_TRANSIENT_FLUX:
        logger.info(
            "no transients in the %s band (peak flux %.4f < %.2f); returning zeros",
            band, peak, MIN_TRANSIENT_FLUX,
        )
        return np.zeros(frame_count, dtype=np.float32)

    flux /= peak

    decay = float(np.clip(decay, 0.0, 0.99))
    out = np.empty_like(flux)
    running = 0.0
    for i, value in enumerate(flux):
        running = max(value, running * decay)
        out[i] = running
    return out.astype(np.float32)


def synthetic_envelope(frame_count: int, fps: float, bpm: float = 120.0,
                       decay: float = 0.6) -> np.ndarray:
    """
    A beat envelope with no audio file, for previewing motion.

    Kept explicit rather than used as a silent fallback: a caller that thinks it
    is driving animation from a track should never be handed a synthetic pulse
    without knowing.
    """
    if frame_count <= 0 or fps <= 0 or bpm <= 0:
        raise ValueError("frame_count, fps and bpm must all be positive")

    frames_per_beat = (60.0 / bpm) * fps
    out = np.zeros(frame_count, dtype=np.float32)
    running = 0.0
    next_beat = 0.0
    for i in range(frame_count):
        if i >= next_beat:
            running = 1.0
            next_beat += frames_per_beat
        out[i] = running
        running *= decay
    return out


def describe(audio_path: str) -> dict:
    """Duration, sample rate and per-band mean level, for sanity-checking a track."""
    samples, rate = _decode_to_wav(Path(audio_path))
    duration = len(samples) / rate

    window = 4096
    taper = np.hanning(window).astype(np.float32)
    freqs = np.fft.rfftfreq(window, 1.0 / rate)

    hops = max(1, len(samples) // window)
    levels = {name: 0.0 for name in BANDS}
    for i in range(hops):
        chunk = samples[i * window: (i + 1) * window]
        if len(chunk) < window:
            break
        spectrum = np.abs(np.fft.rfft(chunk * taper))
        for name, (low, high) in BANDS.items():
            bins = (freqs >= low) & (freqs <= high)
            if bins.any():
                levels[name] += float(np.sqrt(np.mean(spectrum[bins] ** 2)))

    loudest = max(levels.values()) or 1.0
    return {
        "duration_seconds": round(duration, 2),
        "sample_rate": rate,
        "band_levels": {k: round(v / loudest, 3) for k, v in levels.items()},
    }
