"""On-device speech-to-text with faster-whisper.

Nothing leaves the machine here: the model runs locally on CPU (CTranslate2),
so the recorded audio never touches a network. The model is loaded once,
lazily, behind a lock because Flask serves requests from multiple threads.
"""

import collections
import io
import logging
import os
import pathlib
import re
import threading
import time

import av
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

log = logging.getLogger(__name__)

MODEL_SIZE = os.getenv("WHISPER_MODEL", "small.en")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE", "int8")
DEBUG_AUDIO = os.getenv("DEBUG_AUDIO", "0") == "1"

SILENCE_PEAK = 0.005

_HALLUCINATIONS = {
    "you", "thank you", "thanks for watching", "thank you for watching",
    "bye", "bye.", "okay", "ok", "so", "uh", "um", "hmm", "mm",
    "please subscribe", "subtitles by the amara.org community",
    "transcription by eso translations",
}

Heard = collections.namedtuple("Heard", "text peak seconds")

def _is_hallucination(text: str) -> bool:
    """True if the transcript is one of Whisper's stock non-speech outputs."""
    bare = re.sub(r"[^a-z0-9.\s]", "", text.lower()).strip().rstrip(".")
    return bare in _HALLUCINATIONS or len(bare) < 2

_model = None
_model_lock = threading.Lock()

def load_model():
    """Return the shared WhisperModel, downloading/initialising it on first use."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                log.info("loading whisper model %s (%s)...", MODEL_SIZE, COMPUTE_TYPE)
                _model = WhisperModel(
                    MODEL_SIZE,
                    device="cpu",
                    compute_type=COMPUTE_TYPE,
                    cpu_threads=os.cpu_count() or 4,
                )
                log.info("whisper model ready")
    return _model

def _probe(audio_bytes: bytes) -> str:
    """Describe what the container actually holds, for the log."""
    try:
        with av.open(io.BytesIO(audio_bytes)) as c:
            parts = [f"format={c.format.name}"]
            for st in c.streams:
                if st.type == "audio":
                    parts.append(
                        f"codec={st.codec_context.name} "
                        f"rate={st.codec_context.sample_rate} "
                        f"channels={st.codec_context.channels}"
                    )
            parts.append(f"container_duration={c.duration}")
            return " ".join(parts)
    except Exception as exc:
        return f"unreadable container: {exc!r}"

def transcribe(audio_bytes: bytes) -> Heard:
    """Transcribe recorded audio (webm/opus, mp4/aac, wav...) into plain text."""
    model = load_model()
    log.info("clip: %d bytes | %s", len(audio_bytes), _probe(audio_bytes))

    if DEBUG_AUDIO:
        out = pathlib.Path("debug_audio")
        out.mkdir(exist_ok=True)
        dump = out / f"clip-{int(time.time())}.webm"
        dump.write_bytes(audio_bytes)
        log.info("clip saved to %s", dump)

    try:
        pcm = decode_audio(io.BytesIO(audio_bytes), sampling_rate=16000)
    except Exception:
        log.exception("could not decode audio")
        raise

    seconds = len(pcm) / 16000
    peak = float(abs(pcm).max()) if len(pcm) else 0.0
    rms = float((pcm.astype("float64") ** 2).mean() ** 0.5) if len(pcm) else 0.0
    log.info("decoded: %.2fs @16kHz | peak=%.4f rms=%.4f", seconds, peak, rms)

    if len(pcm) == 0:
        log.warning("decoder produced zero samples - the container did not decode")
        return Heard("", 0.0, 0.0)
    if peak < SILENCE_PEAK:
        log.warning("audio is effectively silent (peak=%.5f) - check the microphone", peak)
        return Heard("", peak, seconds)

    segments, info = model.transcribe(
        pcm,
        beam_size=5,
        language="en" if MODEL_SIZE.endswith(".en") else None,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 400, "threshold": 0.25},
        condition_on_previous_text=False,
    )
    segments = list(segments)
    log.info("whisper: %d segment(s), vad kept %.2fs of %.2fs",
             len(segments), getattr(info, "duration_after_vad", -1), info.duration)
    for s in segments:
        log.info("  [%.2f-%.2f] %r", s.start, s.end, s.text)

    text = " ".join(s.text.strip() for s in segments).strip()

    if not text and peak >= SILENCE_PEAK:
        log.warning("nothing survived the VAD - retrying without it")
        segments, info = model.transcribe(
            pcm,
            beam_size=5,
            language="en" if MODEL_SIZE.endswith(".en") else None,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        segments = list(segments)
        for s in segments:
            log.info("  (no-vad) [%.2f-%.2f] %r", s.start, s.end, s.text)
        text = " ".join(s.text.strip() for s in segments).strip()

    if text and _is_hallucination(text):
        log.info("discarding %r - that is a known non-speech artefact", text)
        text = ""

    return Heard(text, peak, seconds)
