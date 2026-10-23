"""Write a tiny stand-in for a U2-Net matte model (same input and output shapes) for the cutout tests.

The graph is one ReduceMean over the colour channels: bright pixels score high, dark ones low, and
remove_bg.py's min-max normalisation turns that into an opaque white square on a transparent black
background. The ONNX protobuf is encoded by hand, so no `onnx` or `torch` package is needed.

Usage: python fake_matte_model.py OUT.onnx [SIZE]
"""

from __future__ import annotations

import sys


def varint(n: int) -> bytes:
    """Protobuf base-128 varint."""
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def field(num: int, value: int | str | bytes) -> bytes:
    """One protobuf field: varint for ints, length-delimited for strings and messages."""
    if isinstance(value, int):
        return varint(num << 3) + varint(value)
    data = value.encode() if isinstance(value, str) else value
    return varint((num << 3) | 2) + varint(len(data)) + data


def tensor_info(name: str, dims: list[int]) -> bytes:
    """ValueInfoProto for a float tensor."""
    shape = b"".join(field(1, field(1, d)) for d in dims)
    tensor = field(1, 1) + field(2, shape)  # elem_type FLOAT, shape
    return field(1, name) + field(2, field(1, tensor))


def model(size: int) -> bytes:
    """ModelProto: input[1,3,S,S] -> ReduceMean(axes=[1], keepdims=1) -> mask[1,1,S,S], opset 13."""
    axes = field(1, "axes") + field(8, 1) + field(20, 7)  # INTS
    keep = field(1, "keepdims") + field(3, 1) + field(20, 2)  # INT
    node = field(1, "input") + field(2, "mask") + field(4, "ReduceMean") + field(5, axes) + field(5, keep)
    graph = field(1, node) + field(2, "fake_matte") + field(11, tensor_info("input", [1, 3, size, size])) + field(12, tensor_info("mask", [1, 1, size, size]))
    return field(1, 7) + field(7, graph) + field(8, field(1, "") + field(2, 13))


def main() -> None:
    """Write the stand-in model."""
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 320
    with open(sys.argv[1], "wb") as f:
        f.write(model(size))


if __name__ == "__main__":
    main()
