/** Owns only a local preview stream; never records or publishes media. */
export class LocalCameraSession {
  private generation = 0;
  private stream: MediaStream | null = null;
  constructor(
    private request: (
      constraints: MediaStreamConstraints,
    ) => Promise<MediaStream>,
  ) {}
  stop() {
    this.generation++;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
  async start(facingMode: "user" | "environment") {
    this.stop();
    const generation = this.generation;
    let stream: MediaStream;
    try {
      stream = await this.request({
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    } catch (error) {
      if (generation !== this.generation) return null;
      throw error;
    }
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }
    this.stream = stream;
    return stream;
  }
}
