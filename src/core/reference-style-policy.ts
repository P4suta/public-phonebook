export function stripReferenceStyle(property: string): boolean {
  //@ verify
  //@ ensures \result === (property === "color" || property === "background" || property === "background-color" || property === "background-image" || property === "border" || property === "border-top" || property === "border-right" || property === "border-bottom" || property === "border-left" || property === "border-color" || property === "border-top-color" || property === "border-right-color" || property === "border-bottom-color" || property === "border-left-color" || property === "outline" || property === "outline-color" || property === "text-decoration-color" || property === "fill" || property === "stroke" || property === "box-shadow" || property === "text-shadow" || property === "filter" || property === "backdrop-filter" || property === "mix-blend-mode" || property === "opacity" || property === "animation" || property === "animation-name" || property === "transition" || property === "mask" || property === "mask-image" || property === "-webkit-mask" || property === "-webkit-mask-image" || property === "fill-opacity" || property === "stroke-opacity")
  return (
    property === "color" ||
    property === "background" ||
    property === "background-color" ||
    property === "background-image" ||
    property === "border" ||
    property === "border-top" ||
    property === "border-right" ||
    property === "border-bottom" ||
    property === "border-left" ||
    property === "border-color" ||
    property === "border-top-color" ||
    property === "border-right-color" ||
    property === "border-bottom-color" ||
    property === "border-left-color" ||
    property === "outline" ||
    property === "outline-color" ||
    property === "text-decoration-color" ||
    property === "fill" ||
    property === "stroke" ||
    property === "box-shadow" ||
    property === "text-shadow" ||
    property === "filter" ||
    property === "backdrop-filter" ||
    property === "mix-blend-mode" ||
    property === "opacity" ||
    property === "animation" ||
    property === "animation-name" ||
    property === "transition" ||
    property === "mask" ||
    property === "mask-image" ||
    property === "-webkit-mask" ||
    property === "-webkit-mask-image" ||
    property === "fill-opacity" ||
    property === "stroke-opacity"
  );
}
