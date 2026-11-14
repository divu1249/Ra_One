import os
import requests
import urllib3
import torch
import torchaudio
import soundfile as sf
import numpy as np
from TTS.api import TTS
from pedalboard import Pedalboard, PitchShift, Reverb, Gain

# --- 1. SSL & FFMPEG BYPASS ---
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
old_request = requests.Session.request
def unverified_request(*args, **kwargs):
    kwargs['verify'] = False
    return old_request(*args, **kwargs)
requests.Session.request = unverified_request

os.environ["TTS_HOME"] = "D:/Ra.one/tts_cache"

def fallback_audio_load(filepath, **kwargs):
    data, samplerate = sf.read(filepath, dtype='float32')
    if data.ndim == 1:
        tensor = torch.from_numpy(data).unsqueeze(0) 
    else:
        tensor = torch.from_numpy(data.T)
    return tensor, samplerate
torchaudio.load = fallback_audio_load 

# --- 2. GLOBAL MODEL CACHING (THE FIX) ---
print("[SYSTEM] Pre-loading XTTS Voice Model into RAM...")
device = "cuda" if torch.cuda.is_available() else "cpu"
global_tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
print("[SYSTEM] Voice Engine Ready.")

# --- 3. SYNTHESIS PIPELINE ---
def synthesize_ra_one(text_input):
    print(f"\n[AUDIO] Generating {len(text_input.split())} words...")
    
    raw_path = "ra_one_RAW.wav"
    global_tts.tts_to_file(
        text=text_input, 
        speaker_wav="ra_one_reference.wav", 
        language="en", 
        file_path=raw_path
    )
    
    audio, sample_rate = sf.read(raw_path)
    board = Pedalboard([
        PitchShift(semitones=-1.0),
        Reverb(room_size=0.15, dry_level=0.9, wet_level=0.15),
        Gain(gain_db=1.0)
    ])
    
    effected_audio = board(audio, sample_rate)
    sf.write("ra_one_PROCESSED.wav", effected_audio, sample_rate)
    
    if os.path.exists(raw_path):
        os.remove(raw_path)