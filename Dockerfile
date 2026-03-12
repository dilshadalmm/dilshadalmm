# Base Python image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies with a retry mechanism
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libgl1-mesa-glx \
    libglib2.0-0 || \
    (sleep 5 && apt-get update && apt-get install -y --no-install-recommends libgl1-mesa-glx libglib2.0-0) \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY app.py .

# Expose port for Render
EXPOSE 8000

# Start the FastAPI server
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
