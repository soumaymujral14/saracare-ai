FROM python:3.9-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install dependencies
COPY backend/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy all project code
COPY . .

# Bind to 0.0.0.0 and use PORT environment variable
CMD sh -c "python -m uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}"
