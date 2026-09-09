use std::path::Path;

/// Write a mono, 16-bit PCM WAV file at `out_path`.
///
/// `samples`     – raw i16 samples (interleaved if multi-channel, but we only
///                 ever call this with mono data)
/// `sample_rate` – samples per second (e.g. 44100)
/// `channels`    – channel count (always 1 for voice memos)
pub fn write_wav(
    samples: &[i16],
    sample_rate: u32,
    channels: u16,
    out_path: &Path,
) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer =
        hound::WavWriter::create(out_path, spec).map_err(|e| format!("hound create: {e}"))?;
    for &s in samples {
        writer
            .write_sample(s)
            .map_err(|e| format!("hound write: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("hound finalize: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    /// RED first: call write_wav with known samples, then re-open with
    /// hound::WavReader and verify spec + round-tripped sample values.
    #[test]
    fn write_wav_produces_valid_riff_header() {
        let tmp = NamedTempFile::new().expect("tempfile");
        let path = tmp.path();

        let samples: Vec<i16> = vec![0, 100, -100, i16::MAX, i16::MIN];
        write_wav(&samples, 22050, 1, path).expect("write_wav failed");

        let mut reader = hound::WavReader::open(path).expect("WavReader::open failed");
        let spec = reader.spec();

        assert_eq!(spec.channels, 1, "channels");
        assert_eq!(spec.sample_rate, 22050, "sample_rate");
        assert_eq!(spec.bits_per_sample, 16, "bits_per_sample");
        assert_eq!(
            spec.sample_format,
            hound::SampleFormat::Int,
            "sample_format"
        );

        let read_back: Vec<i16> = reader
            .samples::<i16>()
            .map(|s| s.expect("sample read"))
            .collect();
        assert_eq!(read_back, samples, "round-tripped samples must match");
    }

    #[test]
    fn write_wav_empty_samples_produces_valid_file() {
        let tmp = NamedTempFile::new().expect("tempfile");
        write_wav(&[], 22050, 1, tmp.path()).expect("write_wav failed on empty samples");

        let reader = hound::WavReader::open(tmp.path()).expect("WavReader::open failed");
        assert_eq!(reader.spec().sample_rate, 22050);
    }
}
