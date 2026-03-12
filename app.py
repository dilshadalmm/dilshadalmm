from fastapi import FastAPI, UploadFile, File
import easyocr
import numpy as np
from PIL import Image
import io

app = FastAPI()
reader = easyocr.Reader(['en'])

@app.post("/image-to-text/")
async def image_to_text(file: UploadFile = File(...)):
    image_data = await file.read()
    image = Image.open(io.BytesIO(image_data)).convert("RGB")
    image_np = np.array(image)
    result = reader.readtext(image_np)
    text_output = " ".join([t[1] for t in result])
    return {"text": text_output}
