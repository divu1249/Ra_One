# 1. Base Image: A lightweight, headless Linux OS
FROM python:3.11-slim

# 2. Set the working directory inside the container
WORKDIR /app

# 3. Copy the dependency list and install them
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Copy Ra.One's core files into the container
COPY . .

# 5. Expose the neural telemetry port
EXPOSE 8000

# 6. Boot the FastAPI matrix
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]