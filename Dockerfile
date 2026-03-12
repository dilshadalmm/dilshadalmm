# Base Python image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies with high reliability
# We add "set -e" and "apt-get clean" to ensure a fresh state
RUN apt-get update --fix-missing && \
    apt-get install -y --no-install-recommends \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY app.py .

# Expose port for Render
EXPOSE 8000

# Start the FastAPI server using the PORT variable set in Render
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
