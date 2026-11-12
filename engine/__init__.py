"""
WaveWeaver Engine — the Python tool host behind WaveWeaver Studio.

The studio does editing with ffmpeg directly. Anything ffmpeg can't do well
— speech recognition, translation, learned noise reduction, reference
mastering, VST hosting — lives here as a plugin in `engine/tools/`.
"""

__version__ = "1.0.0"
