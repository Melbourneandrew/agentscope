#include <cerrno>
#include <charconv>
#include <climits>
#include <cstdint>
#include <fcntl.h>
#include <linux/fs.h>
#include <string>
#include <string_view>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

namespace {

struct ExpectedIdentity {
	std::uint64_t device;
	std::uint64_t inode;
};

bool ParseUnsigned(const std::string& value, std::uint64_t* output) {
	if (value.empty()) return false;
	const char* first = value.data();
	const char* last = first + value.size();
	auto [next, error] = std::from_chars(first, last, *output, 10);
	return error == std::errc{} && next == last;
}

bool ValidName(const std::string& value) {
	return !value.empty() && value.size() <= 255 && value != "." &&
		value != ".." && value.find('/') == std::string::npos &&
		value.find('\\') == std::string::npos &&
		value.find('\0') == std::string::npos;
}

bool ReadIdentity(
	int directory,
	const std::string& name,
	ExpectedIdentity* output
) {
	struct stat state {};
	if (fstatat(directory, name.c_str(), &state, AT_SYMLINK_NOFOLLOW) != 0 ||
		!S_ISREG(state.st_mode)) return false;
	output->device = static_cast<std::uint64_t>(state.st_dev);
	output->inode = static_cast<std::uint64_t>(state.st_ino);
	return true;
}

bool SameIdentity(
	const ExpectedIdentity& left,
	const ExpectedIdentity& right
) {
	return left.device == right.device && left.inode == right.inode;
}

Napi::Value ExchangeOwnedFiles(const Napi::CallbackInfo& info) {
	Napi::Env env = info.Env();
	if (info.Length() != 7 || !info[0].IsNumber() ||
		!info[1].IsString() || !info[2].IsString() ||
		!info[3].IsString() || !info[4].IsString() ||
		!info[5].IsString() || !info[6].IsString()) {
		Napi::Error::New(env, "destination.local-sqlite.namespace.invalid")
			.ThrowAsJavaScriptException();
		return env.Undefined();
	}
	const double descriptorValue = info[0].As<Napi::Number>().DoubleValue();
	if (descriptorValue < 0 || descriptorValue > INT_MAX ||
		static_cast<double>(static_cast<int>(descriptorValue)) != descriptorValue) {
		Napi::Error::New(env, "destination.local-sqlite.namespace.invalid")
			.ThrowAsJavaScriptException();
		return env.Undefined();
	}
	const int directory = static_cast<int>(descriptorValue);
	struct stat directoryState {};
	if (fstat(directory, &directoryState) != 0 ||
		!S_ISDIR(directoryState.st_mode)) {
		Napi::Error::New(env, "destination.local-sqlite.namespace.invalid")
			.ThrowAsJavaScriptException();
		return env.Undefined();
	}
	const std::string source = info[1].As<Napi::String>().Utf8Value();
	const std::string destination = info[2].As<Napi::String>().Utf8Value();
	ExpectedIdentity expectedSource {};
	ExpectedIdentity expectedDestination {};
	if (!ValidName(source) || !ValidName(destination) || source == destination ||
		!ParseUnsigned(info[3].As<Napi::String>().Utf8Value(), &expectedSource.device) ||
		!ParseUnsigned(info[4].As<Napi::String>().Utf8Value(), &expectedSource.inode) ||
		!ParseUnsigned(info[5].As<Napi::String>().Utf8Value(), &expectedDestination.device) ||
		!ParseUnsigned(info[6].As<Napi::String>().Utf8Value(), &expectedDestination.inode)) {
		Napi::Error::New(env, "destination.local-sqlite.namespace.invalid")
			.ThrowAsJavaScriptException();
		return env.Undefined();
	}
	ExpectedIdentity beforeSource {};
	ExpectedIdentity beforeDestination {};
	if (!ReadIdentity(directory, source, &beforeSource) ||
		!ReadIdentity(directory, destination, &beforeDestination) ||
		!SameIdentity(beforeSource, expectedSource) ||
		!SameIdentity(beforeDestination, expectedDestination)) {
		return Napi::String::New(env, "mismatch");
	}
	if (syscall(
		SYS_renameat2,
		directory,
		source.c_str(),
		directory,
		destination.c_str(),
		RENAME_EXCHANGE
	) != 0) {
		Napi::Error::New(env, "destination.local-sqlite.namespace.unavailable")
			.ThrowAsJavaScriptException();
		return env.Undefined();
	}
	ExpectedIdentity afterSource {};
	ExpectedIdentity afterDestination {};
	if (!ReadIdentity(directory, source, &afterSource) ||
		!ReadIdentity(directory, destination, &afterDestination) ||
		!SameIdentity(afterSource, expectedDestination) ||
		!SameIdentity(afterDestination, expectedSource)) {
		return Napi::String::New(env, "raced");
	}
	return Napi::String::New(env, "exchanged");
}

}  // namespace

void RegisterAgentscopeNamespace(Napi::Env env, Napi::Object exports) {
	exports.Set(
		"agentscopeExchangeOwnedFiles",
		Napi::Function::New(
			env,
			ExchangeOwnedFiles,
			"agentscopeExchangeOwnedFiles"
		)
	);
}
