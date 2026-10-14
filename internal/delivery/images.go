package delivery

import (
	"bytes"
	"codexremote/internal/desktop"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"codexremote/internal/platform"
)

const MaxImageBytes = 8 << 20
const MaxImages = 4
const maxImageStorage = 256 << 20

var fileIDPattern = regexp.MustCompile(`^[a-f0-9]{64}\.file\.[a-z0-9]{1,16}$`)

var imageIDPattern = regexp.MustCompile(`^[a-f0-9]{64}\.(png|jpeg|gif)$`)

func messageDigest(thread, text string, images []string) string {
	if len(images) == 0 {
		// Preserve existing text-only request digests.
		hash := sha256.Sum256([]byte(thread + "\x00" + text))
		return hex.EncodeToString(hash[:])
	}
	data, _ := json.Marshal([]any{thread, text, images})
	hash := sha256.Sum256(data)
	return "images:" + hex.EncodeToString(hash[:])
}

// SaveImage stores only validated raster data under a content-derived name.
func (s *Service) SaveImage(data []byte) (string, error) {
	if len(data) == 0 || len(data) > MaxImageBytes {
		return "", errors.New("每张图片最多 8 MiB")
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg" && format != "gif") {
		return "", errors.New("请选择 PNG、JPEG 或 GIF 图片；HEIC/WebP 请先转换")
	}
	if config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 40_000_000 {
		return "", errors.New("图片分辨率不能超过 4000 万像素")
	}
	hash := sha256.Sum256(data)
	id := hex.EncodeToString(hash[:]) + "." + format
	return s.saveAttachment(id, data)
}

// SaveFile keeps uploaded bytes inert; delivery supplies the local path as text.
func (s *Service) SaveFile(name string, data []byte) (string, error) {
	if len(data) == 0 || len(data) > MaxImageBytes {
		return "", errors.New("每个附件最多 8 MiB，不能为空")
	}
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
	if !regexp.MustCompile(`^[a-z0-9]{1,16}$`).MatchString(ext) {
		ext = "bin"
	}
	hash := sha256.Sum256(data)
	return s.saveAttachment(hex.EncodeToString(hash[:])+".file."+ext, data)
}

func (s *Service) saveAttachment(id string, data []byte) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.diskErr != nil {
		return "", errors.New("发送记录不可写")
	}
	dir := s.queueDir + ".images"
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || !platform.PrivateMode(info) {
		return "", errors.New("附件目录不可用")
	}
	path := filepath.Join(dir, id)
	if _, err := s.imagePath(id); err == nil {
		return id, nil
	}
	files, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	var total int64
	for _, file := range files {
		info, err := file.Info()
		if err != nil {
			return "", err
		}
		total += info.Size()
	}
	if total+int64(len(data)) > maxImageStorage {
		return "", errors.New("附件存储已达 256 MiB，请在电脑维护附件目录后重试")
	}
	f, err := os.CreateTemp(dir, ".upload-")
	if err != nil {
		return "", err
	}
	temp := f.Name()
	defer os.Remove(temp)
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if err = os.Rename(temp, path); err != nil {
		return "", err
	}
	if err = platform.SyncDir(dir); err != nil {
		return "", err
	}
	return id, nil
}

func (s *Service) imagePath(id string) (string, error) {
	if !imageIDPattern.MatchString(id) && !fileIDPattern.MatchString(id) {
		return "", errors.New("附件引用无效")
	}
	path := filepath.Join(s.queueDir+".images", id)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || !platform.PrivateMode(info) || info.Size() <= 0 || info.Size() > MaxImageBytes {
		return "", errors.New("附件不存在或已损坏，请重新添加")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(data)
	if hex.EncodeToString(hash[:]) != id[:64] {
		return "", errors.New("附件校验失败")
	}
	return filepath.Abs(path)
}

func (s *Service) ImagePath(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.imagePath(id)
}

func (s *Service) imagePaths(ids []string) ([]string, error) {
	if len(ids) > MaxImages {
		return nil, errors.New("每条消息最多 4 个附件")
	}
	paths := make([]string, 0, len(ids))
	for _, id := range ids {
		path, err := s.imagePath(id)
		if err != nil {
			return nil, err
		}
		paths = append(paths, path)
	}
	return paths, nil
}

func settingsDigest(thread, text string, images []string, settings *desktop.ModelSettings) string {
	if settings == nil {
		return messageDigest(thread, text, images)
	}
	data, _ := json.Marshal([]any{thread, text, images, settings})
	hash := sha256.Sum256(data)
	return "settings:" + hex.EncodeToString(hash[:])
}

// attachmentInput separates raster inputs from files, which Codex reads by path.
// Keep the persisted images field compatible with existing queued messages.
func (s *Service) attachmentInput(text string, ids []string) (string, []string, error) {
	paths, err := s.imagePaths(ids)
	if err != nil {
		return text, nil, err
	}
	images := make([]string, 0, len(paths))
	for i, path := range paths {
		if fileIDPattern.MatchString(ids[i]) {
			encoded, _ := json.Marshal(path)
			text += "\n\n用户上传的文件（本地路径）：" + string(encoded)
		} else {
			images = append(images, path)
		}
	}
	return text, images, nil
}
