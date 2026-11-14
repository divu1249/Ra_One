import os
from google.oauth2 import service_account
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/drive.readonly']
SERVICE_ACCOUNT_FILE = 'credentials.json'

def get_drive_service():
    """Authenticates the ghost user and returns the Drive API service."""
    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        return None, f"CRITICAL FAULT: {SERVICE_ACCOUNT_FILE} not found."
    try:
        creds = service_account.Credentials.from_service_account_file(SERVICE_ACCOUNT_FILE, scopes=SCOPES)
        service = build('drive', 'v3', credentials=creds)
        return service, "Success"
    except Exception as e:
        return None, f"Authentication Failed: {str(e)}"

def find_data_lake_folder(service, folder_name="Ra_One_Data_Lake"):
    """Scans the Drive to find the exact ID of the Data Lake folder."""
    query = f"name='{folder_name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    results = service.files().list(q=query, spaces='drive', fields='files(id, name)').execute()
    items = results.get('files', [])
    if not items: return None
    return items[0]['id']

def scan_lake():
    """Returns a formatted string of the current Data Lake contents."""
    service, status = get_drive_service()
    if not service: return status
    folder_id = find_data_lake_folder(service)
    if not folder_id: return "ERROR: 'Ra_One_Data_Lake' folder not found."
    
    query = f"'{folder_id}' in parents and trashed=false"
    results = service.files().list(q=query, spaces='drive', fields='files(id, name, mimeType)').execute()
    items = results.get('files', [])
    
    if not items: return "The Data Lake is empty."
    
    output = "DATA LAKE CONTENTS:\n"
    for item in items: output += f" - {item['name']} (ID: {item['id']})\n"
    return output

def read_file(file_id):
    """Downloads and decodes a file from the Data Lake."""
    service, status = get_drive_service()
    if not service: return status
    try:
        # Determine the file type
        file_metadata = service.files().get(fileId=file_id, fields='mimeType, name').execute()
        mime_type = file_metadata.get('mimeType')
        name = file_metadata.get('name')
        
        # Google Workspace documents require a special export command
        if 'application/vnd.google-apps' in mime_type:
            if 'document' in mime_type:
                content = service.files().export_media(fileId=file_id, mimeType='text/plain').execute()
            else:
                return f"ERROR: Cannot read native Google file type: {mime_type}"
        # Standard files (txt, csv, etc.) can be downloaded directly
        else:
            content = service.files().get_media(fileId=file_id).execute()
            
        return f"FILE NAME: {name}\n\nCONTENT:\n{content.decode('utf-8')}"
    except Exception as e:
        return f"ERROR: {str(e)}"