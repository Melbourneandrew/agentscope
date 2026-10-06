#define _POSIX_C_SOURCE 200809L
#define NAPI_VERSION 8
#include <node_api.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_NAMES 1024
#define MAX_BYTES 1048576

static napi_value reject(napi_env env) {
  napi_throw_error(env, NULL, "harness.installation.directory-unavailable");
  return NULL;
}

static int field(napi_env env, napi_value object, const char *name,
                 uint64_t value) {
  napi_value number;
  return napi_create_bigint_uint64(env, value, &number) == napi_ok &&
         napi_set_named_property(env, object, name, number) == napi_ok;
}

static int same_stat(const struct stat *a, const struct stat *b) {
  if (a->st_dev != b->st_dev || a->st_ino != b->st_ino ||
      a->st_mode != b->st_mode || a->st_nlink != b->st_nlink) return 0;
#ifdef __APPLE__
  return a->st_mtimespec.tv_sec == b->st_mtimespec.tv_sec &&
         a->st_mtimespec.tv_nsec == b->st_mtimespec.tv_nsec &&
         a->st_ctimespec.tv_sec == b->st_ctimespec.tv_sec &&
         a->st_ctimespec.tv_nsec == b->st_ctimespec.tv_nsec;
#else
  return a->st_mtim.tv_sec == b->st_mtim.tv_sec &&
         a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
         a->st_ctim.tv_sec == b->st_ctim.tv_sec &&
         a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
#endif
}

static napi_value project(napi_env env, const struct stat *identity,
                          const unsigned char *names, const size_t *lengths,
                          size_t count) {
  napi_value output, entries;
  if (napi_create_object(env, &output) != napi_ok ||
      napi_create_array_with_length(env, count, &entries) != napi_ok ||
      !field(env, output, "dev", (uint64_t)identity->st_dev) ||
      !field(env, output, "ino", (uint64_t)identity->st_ino) ||
      !field(env, output, "mode", (uint64_t)identity->st_mode)) return reject(env);
  size_t offset = 0;
  for (size_t i = 0; i < count; i++) {
    napi_value buffer, entry;
    void *copy;
    if (napi_create_arraybuffer(env, lengths[i], &copy, &buffer) != napi_ok)
      return reject(env);
    memcpy(copy, names + offset, lengths[i]);
    offset += lengths[i];
    if (napi_create_typedarray(env, napi_uint8_array, lengths[i], buffer, 0,
                             &entry) != napi_ok ||
        napi_set_element(env, entries, (uint32_t)i, entry) != napi_ok)
      return reject(env);
  }
  if (napi_set_named_property(env, output, "entries", entries) != napi_ok)
    return reject(env);
  return output;
}

static napi_value observe(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  double input;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 || napi_get_value_double(env, argv[0], &input) != napi_ok ||
      !(input >= 0 && input <= INT_MAX) || (double)(int)input != input)
    return reject(env);
  int duplicate = fcntl((int)input, F_DUPFD_CLOEXEC, 0);
  if (duplicate < 0) return reject(env);
  struct stat before, after;
  if (fstat(duplicate, &before) != 0 || !S_ISDIR(before.st_mode)) {
    close(duplicate);
    return reject(env);
  }
  DIR *stream = fdopendir(duplicate);
  if (!stream) {
    close(duplicate);
    return reject(env);
  }
  unsigned char *names = malloc(MAX_BYTES);
  size_t lengths[MAX_NAMES], count = 0, bytes = 0;
  int valid = names != NULL;
  while (valid) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (!entry) {
      valid = errno == 0;
      break;
    }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    size_t length = strlen(entry->d_name);
    if (!length || count == MAX_NAMES || length > MAX_BYTES - bytes) {
      valid = 0;
      break;
    }
    lengths[count++] = length;
    memcpy(names + bytes, entry->d_name, length);
    bytes += length;
  }
  if (fstat(dirfd(stream), &after) != 0 || !same_stat(&before, &after)) valid = 0;
  if (closedir(stream) != 0) valid = 0;
  napi_value result = valid ? project(env, &after, names, lengths, count)
                            : reject(env);
  free(names);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "observeDirectory", NAPI_AUTO_LENGTH, observe,
                           NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "observeDirectory", function) != napi_ok)
    return reject(env);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
