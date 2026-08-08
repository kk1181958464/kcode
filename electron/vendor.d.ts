declare module "pptx2json" {
  const Pptx2Json: new () => {
    toJson(filePath: string): Promise<unknown>;
  };
  export default Pptx2Json;
}
