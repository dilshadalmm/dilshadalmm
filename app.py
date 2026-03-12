from fastapi import FastAPI, UploadFile, File, HTTPException
import easyocr
import numpy as np
from PIL import Image
import io

app = FastAPI()

# Initialize reader once to save memory and time
# 'gpu=False' is recommended for Render's free tier as it lacks a GPU
reader = easyocr.Reader(['en'], gpu=False)

@app.post("/image-to-text") # Matches your updated server.js call
async def image_to_text(file: UploadFile = File(...)):
    try:
        image_data = await file.read()
        image = Image.open(io.BytesIO(image_data)).convert("RGB")
        image_np = np.array(image)
        
        # Paragraph=True helps combine lines into readable sentences
        result = reader.readtext(image_np, paragraph=True)
        text_output = " ".join([t[1] for t in result])
        
        return {"text": text_output}
    except Exception as e:
        print(f"Error processing image: {e}")
        raise HTTPException(status_code=500, detail="Internal OCR Error")
