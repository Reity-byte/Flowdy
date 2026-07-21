declare module "mixbox" {
  type PackedColor =
    | [number, number, number]
    | [number, number, number, number]
    | { r: number; g: number; b: number; a?: number }
    | string
    | number;

  const mixbox: {
    LATENT_SIZE: number;
    lerp(color1: PackedColor, color2: PackedColor, t: number): number[];
  };

  export default mixbox;
}
