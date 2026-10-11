# On-device segmentation model

`silueta.onnx` powers the AI masks (Select Subject, Background, People and
Object). It runs locally through ONNX Runtime Web; photos never leave the
computer.

- Architecture: U²-Net (Qin et al., 2020), Apache License 2.0,
  https://github.com/xuebinqin/U-2-Net
- Weights: "silueta" from rembg, MIT License,
  https://github.com/danielgatis/rembg
- SHA-256: 75da6c8d2f8096ec743d071951be73b4a8bc7b3e51d9a6625d63644f90ffeedb
