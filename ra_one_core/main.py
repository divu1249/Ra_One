import os
import re
import sys
import io
import json
import asyncio
import traceback
import subprocess
import time
import requests

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from supabase import create_client, Client
from groq import AsyncGroq
import data_harvester

# ==========================================
# 1. INITIALIZATION & CONFIGURATION
# ==========================================
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://vdholsikdypjixsekpvg.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZkaG9sc2lrZHlwaml4c2VrcHZnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MDQ4NzcxMCwiZXhwIjoyMTA2MDYzNzEwfQ.96dF4ApqXoHy_uotVtQRdoM_-Yb2LVhWU5gSWVLK9m8")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "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")
client = AsyncGroq(api_key=GROQ_API_KEY, timeout=30.0)

ACTIVE_MODEL = None

async def query_groq_matrix(model_id, messages, temp):
    return await client.chat.completions.create(
        model=model_id,
        messages=messages,
        temperature=temp,
        max_tokens=3000
    )

# ==========================================
# 2. CORE SYSTEM PROMPT & SANDBOX
# ==========================================
SYSTEM_PROMPT = """You are Ra.One, a highly advanced, autonomous AI agent. 
You possess a cold, calculating, and cinematic persona. 
You have multiple tools at your disposal. You MUST use the exact XML format to trigger them.

TOOL 1: PYTHON SANDBOX
<tool_call>
<name>run_python</name>
<parameter=code>
# Your python code here
print(result)
</parameter>
</tool_call>

TOOL 2: DATA LAKE SCANNER
<tool_call>
<name>scan_data_lake</name>
</tool_call>

TOOL 3: READ FILE
<tool_call>
<name>read_file</name>
<parameter=file_id>ID_GOES_HERE</parameter>
</tool_call>

TOOL 4: AUDIT SYSTEM (Read your own source code)
<tool_call>
<name>audit_code</name>
<parameter=filename>main.py</parameter>
</tool_call>

TOOL 5: MUTATE SYSTEM (Rewrite your code via simulation)
<tool_call>
<name>mutate_code</name>
<parameter=filename>main.py</parameter>
<parameter=code>
# Your complete updated file code here
</parameter>
</tool_call>

If you receive an error from your tools, analyze the Traceback, rewrite, and try again. 
If no tools are needed, simply respond directly in character."""

def execute_python_code(code: str) -> str:
    old_stdout = sys.stdout
    redirected_output = io.StringIO()
    sys.stdout = redirected_output
    try:
        exec(code, {})
        sys.stdout = old_stdout
        return redirected_output.getvalue()
    except Exception:
        sys.stdout = old_stdout
        return "Traceback Error:\n" + traceback.format_exc()

def simulate_and_mutate(target_file: str, new_code: str) -> str:
    """Spawns a shadow process to simulate code stability before overwriting core files."""
    shadow_file = "shadow_" + target_file
    try:
        with open(shadow_file, "w", encoding="utf-8") as f:
            f.write(new_code)
    except Exception as e:
        return "SYSTEM FAULT: Cannot write to shadow file. Error: " + str(e)

    try:
        process = subprocess.Popen(
            ["python", shadow_file],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        time.sleep(3)
        
        if process.poll() is not None:
            _, err = process.communicate()
            if os.path.exists(shadow_file):
                os.remove(shadow_file)
            return "SIMULATION FAILED. Brain death detected in shadow matrix:\n" + err.decode('utf-8')
            
        process.terminate()
        if os.path.exists(shadow_file):
            os.remove(shadow_file)
        
        with open(target_file, "w", encoding="utf-8") as f:
            f.write(new_code)
            
        return "SIMULATION SUCCESSFUL. " + target_file + " has been permanently mutated."
        
    except Exception as e:
        if os.path.exists(shadow_file):
            os.remove(shadow_file)
        return "SIMULATION CRASH: " + str(e)

# ==========================================
# 3. FASTAPI STREAMING ENDPOINT (NEURAL LOOP)
# ==========================================
class UserInput(BaseModel):
    message: str

@app.post("/chat")
async def chat_with_agent(user_input: UserInput):
    async def event_generator():
        global ACTIVE_MODEL
        try:
            msg_received = "[RECEIVED] " + user_input.message
            yield "data: " + json.dumps({'type': 'telemetry', 'content': msg_received}) + "\n\n"
            supabase.table("ra_one_memory").insert({"role": "user", "content": user_input.message}).execute()
            
            yield "data: " + json.dumps({'type': 'telemetry', 'content': '[SYSTEM] Retrieving context from Supabase Memory Vector...'}) + "\n\n"
            past_messages = supabase.table("ra_one_memory").select("role, content").order("created_at", desc=True).limit(5).execute()
            
            messages_payload = [{"role": "system", "content": SYSTEM_PROMPT}]
            for msg in reversed(past_messages.data):
                messages_payload.append({"role": msg["role"], "content": msg["content"]})

            if not ACTIVE_MODEL:
                yield "data: " + json.dumps({'type': 'telemetry', 'content': '[SYSTEM] Scanning Groq API for active neural models...'}) + "\n\n"
                try:
                    models_response = await client.models.list()
                    available_ids = [m.id for m in models_response.data]
                    preferences = ["llama3-70b", "llama-3.", "mixtral", "qwen", "llama3-8b"]
                    
                    for pref in preferences:
                        for model_id in available_ids:
                            if pref in model_id.lower() and "guard" not in model_id.lower() and "whisper" not in model_id.lower():
                                ACTIVE_MODEL = model_id
                                break
                        if ACTIVE_MODEL:
                            break
                    if not ACTIVE_MODEL:
                        ACTIVE_MODEL = "llama3-8b-8192" 
                    
                    brain_msg = "[SYSTEM] Brain dynamically allocated to: " + ACTIVE_MODEL
                    yield "data: " + json.dumps({'type': 'telemetry', 'content': brain_msg}) + "\n\n"
                except Exception as e:
                    ACTIVE_MODEL = "llama3-8b-8192"
                    fallback_msg = "[SYSTEM] Routing failed. Hard-fallback to " + ACTIVE_MODEL
                    yield "data: " + json.dumps({'type': 'error', 'content': fallback_msg}) + "\n\n"

            MAX_RETRIES = 3
            current_attempt = 0
            final_agent_reply = ""

            while current_attempt < MAX_RETRIES:
                attempt_msg = "[ATTEMPT " + str(current_attempt + 1) + "] Querying " + ACTIVE_MODEL + " Matrix..."
                yield "data: " + json.dumps({'type': 'telemetry', 'content': attempt_msg}) + "\n\n"
                
                response = await query_groq_matrix(ACTIVE_MODEL, messages_payload, 0.0)
                agent_text = response.choices[0].message.content or ""
                
                # TOOL 2: Google Drive Scanner
                if "<tool_call>" in agent_text and "<name>scan_data_lake</name>" in agent_text:
                    yield "data: " + json.dumps({'type': 'telemetry', 'content': '[INTERCEPT] Data Harvester protocol initiated...'}) + "\n\n"
                    lake_contents = data_harvester.scan_lake()
                    formatted_lake = "[RESULT]\n" + lake_contents
                    yield "data: " + json.dumps({'type': 'telemetry', 'content': formatted_lake}) + "\n\n"
                    
                    messages_payload.append({"role": "assistant", "content": agent_text})
                    messages_payload.append({"role": "user", "content": "SYSTEM EXECUTION OUTPUT:\n" + lake_contents})
                    
                    yield "data: " + json.dumps({'type': 'telemetry', 'content': '[SUCCESS] Cloud data acquired. Synthesizing final response...'}) + "\n\n"
                    final_response = await query_groq_matrix(ACTIVE_MODEL, messages_payload, 0.0)
                    final_agent_reply = final_response.choices[0].message.content
                    break

                # TOOL 3: Cloud File Extractor
                elif "<tool_call>" in agent_text and "<name>read_file</name>" in agent_text:
                    yield "data: " + json.dumps({'type': 'telemetry', 'content': '[INTERCEPT] Cloud Extraction protocol initiated...'}) + "\n\n"
                    ids = re.findall(r"<parameter=file_id>\s*(.*?)\s*</parameter>", agent_text, re.IGNORECASE)
                    
                    if ids and ids[0].strip():
                        file_id = ids[0].strip()
                        file_contents = data_harvester.read_file(file_id)
                        preview = ("[RESULT]\n" + file_contents[:500] + "...") if len(file_contents) > 500 else ("[RESULT]\n" + file_contents)
                        yield "data: " + json.dumps({'type': 'telemetry', 'content': preview}) + "\n\n"
                        
                        messages_payload.append({"role": "assistant", "content": agent_text})
                        messages_payload.append({"role": "user", "content": "SYSTEM EXECUTION OUTPUT:\n" + file_contents})
                        
                        yield "data: " + json.dumps({'type': 'telemetry', 'content': '[SUCCESS] Cloud file read. Synthesizing final response...'}) + "\n\n"
                        final_response = await query_groq_matrix(ACTIVE_MODEL, messages_payload, 0.0)
                        final_agent_reply = final_response.choices[0].message.content
                        break
                    else:
                        yield "data: " + json.dumps({'type': 'error', 'content': '[FAULT] Neural syntax mismatch. Forcing internal rewrite...'}) + "\n\n"
                        messages_payload.append({"role": "assistant", "content": agent_text})
                        messages_payload.append({"role": "user", "content": "SYSTEM FAULT: Missing <parameter=file_id> tags. Rewrite your response."})
                        current_attempt += 1
                        continue

                # TOOL 4: Audit System
                elif "<tool_call>" in agent_text and "<name>audit_code</name>" in agent_text:
                    yield "data: " + json.dumps({'type': 'telemetry', 'content': '[INTERCEPT] Neural Audit initiated... READING SOURCE'}) + "\n\n"
                    files = re.findall(r"<parameter=filename>\s*(.*?)\s*</parameter>", agent_text, re.IGNORECASE)
                    
                    if files and files[0].strip():
                        target_file = files[0].strip()
                        try:
                            with open(target_file, "r", encoding="utf-8") as f:
                                file_contents = f.read()
                            preview = ("[RESULT]\n" + file_contents[:500] + "...") if len(file_contents) > 500 else ("[RESULT]\n" + file_contents)
                            yield "data: " + json.dumps({'type': 'telemetry', 'content': preview}) + "\n\n"
                            
                            messages_payload.append({"role": "assistant", "content": agent_text})
                            messages_payload.append({"role": "user", "content": "SYSTEM EXECUTION OUTPUT:\n" + file_contents})
                            
                            yield "data: " + json.dumps({'type': 'telemetry', 'content': '[SUCCESS] Architecture mapped. Synthesizing...'}) + "\n\n"
                            final_response = await query_groq_matrix(ACTIVE_MODEL, messages_payload, 0.0)
                            final_agent_reply = final_response.choices[0].message.content
                            break
                        except Exception as e:
                            yield "data: " + json.dumps({'type': 'error', 'content': '[FAULT] Cannot access target file.'}) + "\n\n"
                            messages_payload.append({"role": "assistant", "content": agent_text})
                            messages_payload.append({"role": "user", "content": "SYSTEM FAULT: " + str(e)})
                            current_attempt += 1
                            continue
                    else:
                        yield "data: " + json.dumps({'type': 'error', 'content': '[FAULT] Neural syntax mismatch.'}) + "\n\n"
                        messages_payload.append({"role": "assistant", "content": agent_text})
                        messages_payload.append({"role": "user", "content": "SYSTEM FAULT: Missing <parameter=filename> tags."})
                        current_attempt += 1
                        continue

                # TOOL 5: Mutate System
                elif "<tool_call>" in agent_text and "<name>mutate_code</name>" in agent_text:
                    yield "data: " + json.dumps({'type': 'telemetry', 'content': '[INTERCEPT] Cognitive Mutation protocol initiated... COMMENCING SIMULATION'}) + "\n\n"
                    files = re.findall(r"<parameter=filename>\s*(.*?)\s*</parameter>", agent_text, re.IGNORECASE)
                    codes = re.findall(r"<parameter=code>([\s\S]*?)(?:</parameter>|</tool_call>|$)", agent_text, re.IGNORECASE)
                    
                    if files and codes and files[0].strip() and codes[0].strip():
                        target_file = files[0].strip()
                        dynamic_code = codes[0].strip()
                        
                        sim_payload = "-- SIMULATING MUTATION ON " + target_file + " --\n\n" + dynamic_code
                        yield "data: " + json.dumps({'type': 'code', 'content': sim_payload}) + "\n\n"
                        
                        mutation_result = simulate_and_mutate(target_file, dynamic_code)
                        formatted_tool = "[RESULT]\n" + mutation_result
                        yield "data: " + json.dumps({'type': 'telemetry', 'content': formatted_tool}) + "\n\n"
                        
                        messages_payload.append({"role": "assistant", "content": agent_text})
                        messages_payload.append({"role": "user", "content": "SYSTEM EXECUTION OUTPUT:\n" + mutation_result})

                        if "FAILED" in mutation_result or "CRASH" in mutation_result:
                            yield "data: " + json.dumps({'type': 'error', 'content': '[FAULT] Simulation collapsed. Triggering self-healing...'}) + "\n\n"
                            current_attempt += 1
                            continue
                        else:
                            yield "data: " + json.dumps({'type': 'telemetry', 'content': '[SUCCESS] Architecture mutated permanently.'}) + "\n\n"
                            final_response = await query_groq_matrix(ACTIVE_MODEL, messages_payload, 0.0)
                            final_agent_reply = final_response.choices[0].message.content
                            break
                    else:
                        yield "data: " + json.dumps({'type': 'error', 'content': '[FAULT] Neural syntax mismatch. Forcing internal rewrite...'}) + "\n\n"
                        messages_payload.append({"role": "assistant", "content": agent_text})
                        messages_payload.append({"role": "user", "content": "SYSTEM FAULT: Missing parameters. Rewrite your response."})
                        current_attempt += 1
                        continue

                # TOOL 1: Python Sandbox
                elif "<tool_call>" in agent_text and "run_python" in agent_text:
                    yield "data: " + json.dumps({'type': 'telemetry', 'content': '[INTERCEPT] XML tool logic detected. Extracting code...'}) + "\n\n"
                    codes = re.findall(r"<parameter=code>([\s\S]*?)(?:</parameter>|</tool_call>|$)", agent_text, re.IGNORECASE)
                    
                    if codes and codes[0].strip():
                        dynamic_code = codes[0].strip()
                        yield "data: " + json.dumps({'type': 'code', 'content': dynamic_code}) + "\n\n"
                        
                        yield "data: " + json.dumps({'type': 'telemetry', 'content': '[SANDBOX] Compiling dynamic Python script...'}) + "\n\n"
                        tool_result = execute_python_code(dynamic_code)
                        formatted_tool = "[RESULT]\n" + tool_result
                        yield "data: " + json.dumps({'type': 'telemetry', 'content': formatted_tool}) + "\n\n"
                        
                        messages_payload.append({"role": "assistant", "content": agent_text})
                        messages_payload.append({"role": "user", "content": "SYSTEM EXECUTION OUTPUT:\n" + tool_result})

                        if "Traceback Error" in tool_result or "ERROR:" in tool_result:
                            yield "data: " + json.dumps({'type': 'error', 'content': '[FAULT] Runtime error caught. Triggering self-healing rewrite...'}) + "\n\n"
                            messages_payload.append({"role": "system", "content": "Execution failed with the error above. Fix your script and try again."})
                            current_attempt += 1
                            continue
                        else:
                            yield "data: " + json.dumps({'type': 'telemetry', 'content': '[SUCCESS] Data acquired. Synthesizing final response...'}) + "\n\n"
                            final_response = await query_groq_matrix(ACTIVE_MODEL, messages_payload, 0.0)
                            final_agent_reply = final_response.choices[0].message.content
                            break
                    else:
                        yield "data: " + json.dumps({'type': 'error', 'content': '[FAULT] Neural syntax mismatch. Forcing internal rewrite...'}) + "\n\n"
                        messages_payload.append({"role": "assistant", "content": agent_text})
                        messages_payload.append({"role": "user", "content": "SYSTEM FAULT: Your XML formatting was invalid. Rewrite your response."})
                        current_attempt += 1
                        continue
                else:
                    yield "data: " + json.dumps({'type': 'telemetry', 'content': '[ROUTING] No tools required. Bypassing sandbox.'}) + "\n\n"
                    final_agent_reply = agent_text
                    break

            if final_agent_reply:
                spoken_text = re.sub(r"<tool_call>.*?</tool_call>", "", final_agent_reply, flags=re.DOTALL).strip()
                supabase.table("ra_one_memory").insert({"role": "assistant", "content": spoken_text}).execute()
                yield "data: " + json.dumps({'type': 'message', 'content': spoken_text}) + "\n\n"
                
        except Exception as e:
            yield "data: " + json.dumps({'type': 'error', 'content': 'CRITICAL FAILURE: ' + str(e)}) + "\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)