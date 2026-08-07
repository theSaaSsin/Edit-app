"""
Collage Studio — desktop masking and edge-FX workspace.

    pip install PyQt6
    python -m backend.ui.studio [image.png]

Left pane is the source with the live selection tinted over it; right pane is the
rendered asset with its edge material applied. All processing is CPU-only.

The FX render is deliberately not run on every mouse move — it costs a few
hundred milliseconds — so it is debounced behind a timer that fires once the
stroke settles, and the preview renders at viewport resolution rather than full
resolution while you work.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

import numpy as np
from PIL import Image

try:
    from PyQt6.QtCore import Qt, QTimer, QPoint
    from PyQt6.QtGui import QImage, QPixmap, QAction, QKeySequence
    from PyQt6.QtWidgets import (
        QApplication, QMainWindow, QWidget, QLabel, QSlider, QComboBox, QPushButton,
        QVBoxLayout, QHBoxLayout, QGroupBox, QFileDialog, QMessageBox, QSizePolicy,
        QRadioButton, QButtonGroup, QStatusBar,
    )
except ImportError as exc:  # pragma: no cover - import guard
    raise SystemExit(
        "Collage Studio needs PyQt6.\n\n    pip install PyQt6\n"
    ) from exc

from backend.pipeline.edge_fx import EDGE_STYLES, EdgeFXEngine
from backend.pipeline.selection import SelectionEngine

logger = logging.getLogger(__name__)

DARK_QSS = """
QMainWindow, QWidget { background: #1e1f22; color: #d6d6d8; }
QGroupBox {
    border: 1px solid #34363b; border-radius: 6px;
    margin-top: 10px; padding-top: 10px; font-weight: 600;
}
QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px; color: #9aa0a6; }
QLabel { color: #c8c9cc; }
QPushButton {
    background: #2c2e33; border: 1px solid #3c3f46; border-radius: 5px;
    padding: 6px 10px; color: #e2e2e4;
}
QPushButton:hover { background: #35383f; }
QPushButton:pressed { background: #23252a; }
QPushButton#primary { background: #3d5afe; border-color: #3d5afe; color: white; }
QPushButton#primary:hover { background: #5570ff; }
QComboBox {
    background: #2c2e33; border: 1px solid #3c3f46;
    border-radius: 5px; padding: 5px 8px;
}
QComboBox QAbstractItemView { background: #2c2e33; selection-background-color: #3d5afe; }
QSlider::groove:horizontal { height: 4px; background: #3c3f46; border-radius: 2px; }
QSlider::handle:horizontal {
    background: #8ab4f8; width: 14px; margin: -6px 0; border-radius: 7px;
}
QLabel#canvas { background: #141518; border: 1px solid #303236; border-radius: 6px; }
QStatusBar { color: #9aa0a6; }
"""


def pil_to_pixmap(image: Image.Image) -> QPixmap:
    """Convert a PIL image to a QPixmap, keeping the buffer alive across the call."""
    rgba = image.convert("RGBA")
    data = rgba.tobytes("raw", "RGBA")
    qimage = QImage(data, rgba.width, rgba.height, rgba.width * 4, QImage.Format.Format_RGBA8888)
    return QPixmap.fromImage(qimage.copy())


class CanvasLabel(QLabel):
    """
    Image view that reports mouse positions in *image* coordinates.

    The displayed pixmap is letterboxed to fit the widget, so clicks must be
    mapped back through both the scale factor and the letterbox offset —
    otherwise strokes land offset from the cursor on any non-matching aspect.
    """

    def __init__(self, on_paint=None, parent=None):
        super().__init__(parent)
        self.setObjectName("canvas")
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setMinimumSize(380, 380)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setMouseTracking(True)
        self._on_paint = on_paint
        self._source_size = (1, 1)
        self._painting = False

    def set_image(self, image: Image.Image):
        self._source_size = image.size
        scaled = pil_to_pixmap(image).scaled(
            self.size(), Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self.setPixmap(scaled)

    def _to_image_coords(self, pos: QPoint) -> Optional[tuple[int, int]]:
        pixmap = self.pixmap()
        if pixmap is None or pixmap.isNull():
            return None

        offset_x = (self.width() - pixmap.width()) / 2.0
        offset_y = (self.height() - pixmap.height()) / 2.0
        local_x = pos.x() - offset_x
        local_y = pos.y() - offset_y
        if not (0 <= local_x < pixmap.width() and 0 <= local_y < pixmap.height()):
            return None

        src_w, src_h = self._source_size
        return int(local_x * src_w / pixmap.width()), int(local_y * src_h / pixmap.height())

    def mousePressEvent(self, event):
        if event.button() in (Qt.MouseButton.LeftButton, Qt.MouseButton.RightButton):
            self._painting = True
            self._emit(event)

    def mouseMoveEvent(self, event):
        if self._painting:
            self._emit(event)

    def mouseReleaseEvent(self, event):
        self._painting = False
        if self._on_paint:
            self._on_paint(None, False, True)

    def _emit(self, event):
        if not self._on_paint:
            return
        point = self._to_image_coords(event.position().toPoint())
        if point is None:
            return
        # Right button or Alt subtracts, matching the usual raster-editor idiom.
        subtract = (
            event.buttons() & Qt.MouseButton.RightButton
            or event.modifiers() & Qt.KeyboardModifier.AltModifier
        )
        self._on_paint(point, bool(subtract), False)


class LabelledSlider(QWidget):
    """A slider with its name and live value shown above it."""

    def __init__(self, label: str, minimum: int, maximum: int, value: int, suffix: str = ""):
        super().__init__()
        self._label_text = label
        self._suffix = suffix

        self.label = QLabel()
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(minimum, maximum)
        self.slider.setValue(value)
        self.slider.valueChanged.connect(self._refresh)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 2, 0, 2)
        layout.setSpacing(2)
        layout.addWidget(self.label)
        layout.addWidget(self.slider)
        self._refresh()

    def _refresh(self):
        self.label.setText(f"{self._label_text}: {self.slider.value()}{self._suffix}")

    def value(self) -> int:
        return self.slider.value()


class StudioWindow(QMainWindow):
    PREVIEW_MAX = 900  # cap the FX preview so interaction stays responsive

    def __init__(self, image_path: Optional[str] = None):
        super().__init__()
        self.setWindowTitle("Collage Studio")
        self.resize(1440, 900)

        self.selection: Optional[SelectionEngine] = None
        self.source: Optional[Image.Image] = None
        self.fx = EdgeFXEngine()
        self._stroke_open = False

        self._preview_timer = QTimer(self)
        self._preview_timer.setSingleShot(True)
        self._preview_timer.setInterval(220)
        self._preview_timer.timeout.connect(self._render_preview)

        self._build_ui()
        self.setStyleSheet(DARK_QSS)

        if image_path:
            self.load_image(image_path)

    # ---- construction --------------------------------------------------

    def _build_ui(self):
        central = QWidget()
        root = QHBoxLayout(central)
        root.setSpacing(10)
        root.setContentsMargins(10, 10, 10, 10)

        self.source_canvas = CanvasLabel(on_paint=self._handle_paint)
        self.source_canvas.setText("Open an image to begin")
        self.preview_canvas = CanvasLabel()
        self.preview_canvas.setText("Preview")

        for title, canvas in (("Source · paint to select", self.source_canvas),
                              ("Result · edge material applied", self.preview_canvas)):
            box = QGroupBox(title)
            layout = QVBoxLayout(box)
            layout.setContentsMargins(8, 8, 8, 8)
            layout.addWidget(canvas)
            root.addWidget(box, 3)

        root.addWidget(self._build_panel(), 0)
        self.setCentralWidget(central)
        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("Ready")
        self._build_shortcuts()

    def _build_panel(self) -> QWidget:
        panel = QWidget()
        panel.setFixedWidth(310)
        layout = QVBoxLayout(panel)
        layout.setSpacing(8)

        open_btn = QPushButton("Open image…")
        open_btn.clicked.connect(self.open_dialog)
        layout.addWidget(open_btn)

        # Tool
        tool_box = QGroupBox("Tool")
        tool_layout = QVBoxLayout(tool_box)
        self.brush_radio = QRadioButton("Brush")
        self.point_radio = QRadioButton("Control point")
        self.brush_radio.setChecked(True)
        self.tool_group = QButtonGroup(self)
        self.tool_group.addButton(self.brush_radio)
        self.tool_group.addButton(self.point_radio)
        tool_layout.addWidget(self.brush_radio)
        tool_layout.addWidget(self.point_radio)
        tool_layout.addWidget(QLabel("Right-click or Alt to subtract"))
        layout.addWidget(tool_box)

        # Brush
        brush_box = QGroupBox("Brush")
        brush_layout = QVBoxLayout(brush_box)
        self.size_slider = LabelledSlider("Size", 2, 400, 60, " px")
        self.hardness_slider = LabelledSlider("Hardness", 0, 100, 60, "%")
        self.snap_slider = LabelledSlider("Edge snapping", 0, 100, 70, "%")
        self.sensitivity_slider = LabelledSlider("Snap sensitivity", 0, 100, 55)
        for widget in (self.size_slider, self.hardness_slider,
                       self.snap_slider, self.sensitivity_slider):
            brush_layout.addWidget(widget)
        layout.addWidget(brush_box)

        # Mask ops
        mask_box = QGroupBox("Selection")
        mask_layout = QVBoxLayout(mask_box)
        row = QHBoxLayout()
        for text, slot in (("Undo", self.undo), ("Redo", self.redo)):
            button = QPushButton(text)
            button.clicked.connect(slot)
            row.addWidget(button)
        mask_layout.addLayout(row)

        row2 = QHBoxLayout()
        for text, slot in (("Invert", self.invert), ("Clear", self.clear_mask)):
            button = QPushButton(text)
            button.clicked.connect(slot)
            row2.addWidget(button)
        mask_layout.addLayout(row2)

        refine = QPushButton("Refine edges (GrabCut)")
        refine.clicked.connect(self.refine)
        mask_layout.addWidget(refine)

        self.feather_slider = LabelledSlider("Feather selection", 0, 50, 0, " px")
        self.feather_slider.slider.sliderReleased.connect(self.apply_feather)
        mask_layout.addWidget(self.feather_slider)
        layout.addWidget(mask_box)

        # Edge FX
        fx_box = QGroupBox("Edge material")
        fx_layout = QVBoxLayout(fx_box)
        self.style_combo = QComboBox()
        self.style_combo.addItems(EDGE_STYLES)
        self.style_combo.setCurrentText("torn_paper")
        self.style_combo.currentTextChanged.connect(self.schedule_preview)
        fx_layout.addWidget(self.style_combo)

        self.fx_width_slider = LabelledSlider("Edge width", 2, 120, 24, " px")
        self.fx_intensity_slider = LabelledSlider("Intensity", 10, 200, 100, "%")
        for widget in (self.fx_width_slider, self.fx_intensity_slider):
            widget.slider.sliderReleased.connect(self.schedule_preview)
            fx_layout.addWidget(widget)
        layout.addWidget(fx_box)

        layout.addStretch(1)

        export_asset = QPushButton("Export asset PNG")
        export_asset.setObjectName("primary")
        export_asset.clicked.connect(self.export_asset)
        layout.addWidget(export_asset)

        export_pair = QPushButton("Export subject + mask")
        export_pair.clicked.connect(self.export_pair)
        layout.addWidget(export_pair)

        return panel

    def _build_shortcuts(self):
        for keys, slot in (
            (QKeySequence.StandardKey.Open, self.open_dialog),
            (QKeySequence.StandardKey.Undo, self.undo),
            (QKeySequence.StandardKey.Redo, self.redo),
            (QKeySequence.StandardKey.Save, self.export_asset),
        ):
            action = QAction(self)
            action.setShortcut(keys)
            action.triggered.connect(slot)
            self.addAction(action)

    # ---- image lifecycle -----------------------------------------------

    def open_dialog(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "Open image", "", "Images (*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff)"
        )
        if path:
            self.load_image(path)

    def load_image(self, path: str):
        try:
            image = Image.open(path)
            image.load()
        except Exception as e:
            QMessageBox.critical(self, "Could not open image", str(e))
            return

        self.source = image.convert("RGBA")
        self.selection = SelectionEngine(self.source)
        self.setWindowTitle(f"Collage Studio — {Path(path).name}")
        self.statusBar().showMessage(f"{Path(path).name} · {image.width}×{image.height}")
        self._refresh_source()
        self._render_preview()

    # ---- interaction ---------------------------------------------------

    def _handle_paint(self, point, subtract: bool, released: bool):
        if self.selection is None:
            return

        if released:
            if self._stroke_open:
                self._stroke_open = False
                self.schedule_preview()
            return

        if point is None:
            return

        # One checkpoint per stroke, not per dab, so undo steps back a whole
        # stroke the way a user expects.
        if not self._stroke_open:
            self.selection.checkpoint()
            self._stroke_open = True

        x, y = point
        if self.brush_radio.isChecked():
            self.selection.paint(
                x, y,
                radius=self.size_slider.value(),
                hardness=self.hardness_slider.value() / 100.0,
                subtract=subtract,
                snap=self.snap_slider.value() / 100.0,
                sensitivity=float(self.sensitivity_slider.value()),
            )
        else:
            self.selection.control_point(
                x, y,
                radius=max(20, self.size_slider.value() * 4),
                tolerance=float(np.interp(self.sensitivity_slider.value(), [0, 100], [70, 8])),
                subtract=subtract,
            )
        self._refresh_source()

    def _refresh_source(self):
        if self.selection is not None:
            self.source_canvas.set_image(self.selection.overlay())

    def schedule_preview(self):
        self._preview_timer.start()

    def _render_preview(self):
        if self.selection is None:
            return

        try:
            cutout = self.selection.cutout()

            # Render the FX at viewport scale; the edge width is scaled to match
            # so the preview looks like the export rather than a different edge.
            span = max(cutout.size)
            factor = min(1.0, self.PREVIEW_MAX / span)
            width = max(2, int(self.fx_width_slider.value() * factor))
            if factor < 1.0:
                cutout = cutout.resize(
                    (max(1, int(cutout.width * factor)), max(1, int(cutout.height * factor))),
                    Image.Resampling.LANCZOS,
                )

            result = self.fx.apply(
                cutout,
                style=self.style_combo.currentText(),
                intensity=self.fx_intensity_slider.value() / 100.0,
                width=width,
                seed=7,
            )
            self.preview_canvas.set_image(result)
        except Exception as e:
            logger.exception("preview failed")
            self.statusBar().showMessage(f"Preview failed: {e}")

    # ---- selection ops -------------------------------------------------

    def _require_selection(self) -> bool:
        if self.selection is None:
            QMessageBox.information(self, "No image", "Open an image first.")
            return False
        return True

    def undo(self):
        if self.selection and self.selection.undo():
            self._refresh_source()
            self.schedule_preview()

    def redo(self):
        if self.selection and self.selection.redo():
            self._refresh_source()
            self.schedule_preview()

    def invert(self):
        if not self._require_selection():
            return
        self.selection.checkpoint()
        self.selection.invert()
        self._refresh_source()
        self.schedule_preview()

    def clear_mask(self):
        if not self._require_selection():
            return
        self.selection.checkpoint()
        self.selection.clear()
        self._refresh_source()
        self.schedule_preview()

    def apply_feather(self):
        if not self._require_selection():
            return
        radius = self.feather_slider.value()
        if radius <= 0:
            return
        self.selection.checkpoint()
        self.selection.feather_mask(radius)
        self._refresh_source()
        self.schedule_preview()

    def refine(self):
        if not self._require_selection():
            return
        self.statusBar().showMessage("Refining…")
        QApplication.processEvents()

        self.selection.checkpoint()
        if self.selection.refine_grabcut():
            self.statusBar().showMessage("Edges refined")
        else:
            self.selection.undo()
            self.statusBar().showMessage("Paint a rough selection first, then refine")
        self._refresh_source()
        self.schedule_preview()

    # ---- export --------------------------------------------------------

    def _full_resolution_asset(self) -> Image.Image:
        return self.fx.apply(
            self.selection.cutout(),
            style=self.style_combo.currentText(),
            intensity=self.fx_intensity_slider.value() / 100.0,
            width=self.fx_width_slider.value(),
            seed=7,
        )

    def export_asset(self):
        if not self._require_selection():
            return
        if not self.selection.mask.any():
            QMessageBox.information(self, "Nothing selected", "Paint a selection first.")
            return

        path, _ = QFileDialog.getSaveFileName(self, "Export asset", "asset.png", "PNG (*.png)")
        if not path:
            return

        self.statusBar().showMessage("Rendering at full resolution…")
        QApplication.processEvents()
        try:
            self._full_resolution_asset().save(path)
            self.statusBar().showMessage(f"Saved {path}")
        except Exception as e:
            QMessageBox.critical(self, "Export failed", str(e))

    def export_pair(self):
        if not self._require_selection():
            return

        directory = QFileDialog.getExistingDirectory(self, "Choose a folder")
        if not directory:
            return

        try:
            out = Path(directory)
            self.selection.cutout().save(out / "Isolated_Subject.png")
            self.selection.mask_image().save(out / "Subject_Alpha_Mask.png")
            self.statusBar().showMessage(f"Saved subject and mask to {out}")
        except Exception as e:
            QMessageBox.critical(self, "Export failed", str(e))

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._refresh_source()
        self.schedule_preview()


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    argv = list(sys.argv if argv is None else argv)

    app = QApplication(argv)
    window = StudioWindow(argv[1] if len(argv) > 1 else None)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
