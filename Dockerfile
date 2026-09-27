# Alternative deployment path (Koyeb, Hugging Face Spaces, any Docker host).
# Zero dependencies — just Python.
FROM python:3.12-slim
WORKDIR /app
COPY server.py ./
COPY app ./app
COPY web ./web
ENV PORT=8000
EXPOSE 8000
CMD ["python3", "server.py"]
